import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';

class LoginDto {
  @IsEmail() @MaxLength(200) email!: string;
  @IsString() @MinLength(12) @MaxLength(200) password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login') login(@Body() dto: LoginDto) { return this.auth.login(dto.email, dto.password); }
  @UseGuards(AuthGuard) @Get('me') me(@Req() req: any) { return req.user; }
}
