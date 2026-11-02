import { Body, Controller, Delete, Get, Param, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { SUPPLIER_ENTRY_TYPES, SupplierEntryType } from '../../common/supplier-ledger';
import { AuthGuard } from '../auth/auth.guard';
import { SupplierLedgerService } from './supplier-ledger.service';

class SupplierEntryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) day!: string;
  @IsIn(SUPPLIER_ENTRY_TYPES) type!: SupplierEntryType;
  @IsOptional() @IsInt() code?: number;
  @IsOptional() @IsNumber() @Min(0) quantity?: number;
  @IsOptional() @IsNumber() @Min(0) amountUzs?: number;
  @IsOptional() @IsNumber() @Min(0) rate?: number;
  @IsOptional() @IsNumber() amountUsd?: number;
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}
class SupplierEntriesDto { @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SupplierEntryDto) entries!: SupplierEntryDto[]; }
class SupplierItemDto {
  @IsInt() @Min(1) code!: number;
  @IsString() @MaxLength(200) title!: string;
  @IsNumber() @Min(0) priceUzs!: number;
  @IsOptional() @IsNumber() @Min(0) priceUsd?: number | null;
}

@UseGuards(AuthGuard)
@Controller('supplier-ledger')
export class SupplierLedgerController {
  constructor(private readonly service: SupplierLedgerService) {}

  @Get() overview() { return this.service.overview(); }
  @Post('items') saveItem(@Body() dto: SupplierItemDto) { return this.service.saveItem(dto); }
  @Post('entries') addEntries(@Body() dto: SupplierEntriesDto) { return this.service.addEntries(dto.entries); }
  @Delete('entries/:id') deleteEntry(@Param('id') id: string) { return this.service.deleteEntry(id); }

  @Post('import')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_request, file, callback) => {
      const allowed = file.originalname.toLowerCase().endsWith('.xlsx');
      callback(allowed ? null : new Error('Поддерживаются только файлы .xlsx'), allowed);
    },
  }))
  import(@UploadedFile() file?: Express.Multer.File, @Body('rate') rate?: string) {
    return this.service.import(file, rate);
  }
}
