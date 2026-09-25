import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ProductsService } from './products.service';

@UseGuards(AuthGuard)
@Controller('products')
export class ProductsController {
  constructor(private service: ProductsService) {}
  @Get()
  list(@Query('search') search?: string,@Query('from') from?: string,@Query('to') to?: string,@Query('compare') compare?: string) {
    return this.service.list(search,{from,to,compare});
  }
}
