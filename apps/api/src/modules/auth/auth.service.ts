import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}
  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new UnauthorizedException('Неверный email или пароль');
    const token = await this.jwt.signAsync({ sub: user.id, email: user.email, role: user.role });
    return { token, user: { id: user.id, email: user.email, role: user.role } };
  }
}
