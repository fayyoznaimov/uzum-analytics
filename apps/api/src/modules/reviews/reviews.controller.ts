import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { ReviewsService } from './reviews.service';

class SyncReviewsDto {
  @IsOptional()
  @IsIn(['ALL', 'NO_REPLY'])
  filter?: 'ALL' | 'NO_REPLY';
}

class SendReviewReplyDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  content?: string;
}

@UseGuards(AuthGuard)
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Get('feed')
  feed(
    @Query('page') page?: string,
    @Query('size') size?: string,
    @Query('filter') filter?: string,
    @Query('rating') rating?: string,
    @Query('search') search?: string,
  ) {
    return this.service.feed({ page, size, filter, rating, search });
  }

  @Post('sync')
  sync(@Body() dto: SyncReviewsDto = {}) {
    return this.service.sync(dto.filter || 'ALL');
  }

  @Post(':id/ai-draft')
  aiDraft(@Param('id') id: string) {
    return this.service.generateAiDraft(id);
  }

  @Post(':id/send-reply')
  sendReply(@Param('id') id: string, @Body() dto: SendReviewReplyDto = {}) {
    return this.service.sendReply(id, dto.content);
  }

  @Post('auto-reply/run')
  autoReply() {
    return this.service.runAutoReplies();
  }

  @Get()
  overview(@Query('search') search?: string) {
    return this.service.overview(search || '');
  }
}
