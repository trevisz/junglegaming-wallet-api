import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/presentation/filters/domain-exception.filter';
import { SqsMessagingService } from '../../src/infrastructure/messaging/sqs-messaging.service';

const app = await NestFactory.create(AppModule, { logger: false });
app.enableShutdownHooks();
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
app.useGlobalFilters(new DomainExceptionFilter());
if (process.env.TEST_EXIT_BEFORE_ACK_ONCE === 'true') {
  const sqs = app.get(SqsMessagingService);
  const acknowledge = sqs.acknowledgeWagerMessage.bind(sqs);
  let shouldExit = true;
  sqs.acknowledgeWagerMessage = async (receiptHandle: string) => {
    if (shouldExit) {
      shouldExit = false;
      process.exit(77);
    }
    await acknowledge(receiptHandle);
  };
}
await app.listen(Number(process.env.PORT));
