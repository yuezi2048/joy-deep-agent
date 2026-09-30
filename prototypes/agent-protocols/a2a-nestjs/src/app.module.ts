import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { TranslateModule } from './translate/translate.module'

@Module({
  imports: [
    // 全局加载 .env
    ConfigModule.forRoot({ isGlobal: true }),
    TranslateModule,
  ],
})
export class AppModule {}
