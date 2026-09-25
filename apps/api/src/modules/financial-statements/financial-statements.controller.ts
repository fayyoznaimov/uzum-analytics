import { Controller, Get, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { FinancialStatementsService } from './financial-statements.service';

@UseGuards(AuthGuard)
@Controller('financial-statements')
export class FinancialStatementsController {
  constructor(private readonly service: FinancialStatementsService) {}

  @Get('latest')
  latest(@Query('returns') returns?: string) {
    return this.service.latest(returns ? Number(returns) : 50);
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_request, file, callback) => {
      const allowed = file.originalname.toLowerCase().endsWith('.xlsx');
      callback(allowed ? null : new Error('Поддерживаются только файлы .xlsx'), allowed);
    },
  }))
  import(@UploadedFile() file?: Express.Multer.File) {
    return this.service.import(file);
  }
}
