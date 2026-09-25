import { Controller, Get, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { WarehouseService } from './warehouse.service';

@UseGuards(AuthGuard)
@Controller('warehouse')
export class WarehouseController {
  constructor(private readonly service: WarehouseService) {}

  @Get('overview')
  overview(@Query('search') search?: string, @Query('status') status?: string) {
    return this.service.overview(search, status);
  }

  @Get('imports')
  imports() { return this.service.imports(); }

  @Post('import')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_request, file, callback) => {
      const allowed = file.originalname.toLowerCase().endsWith('.xlsx');
      callback(allowed ? null : new Error('Поддерживаются только файлы .xlsx'), allowed);
    },
  }))
  import(@UploadedFile() file?: Express.Multer.File) {
    return this.service.import(file);
  }
}
