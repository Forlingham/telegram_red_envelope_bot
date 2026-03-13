import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import { join } from "path";
import { NestExpressApplication } from "@nestjs/platform-express";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  app.setBaseViewsDir(join(__dirname, "..", "modules", "admin", "views"));
  app.setViewEngine("ejs");

  const port = process.env.PORT || 5000;
  await app.listen(port);
  console.log(`Scash Red Envelope Bot is running on port ${port}`);
  console.log(`Web Admin: http://localhost:${port}/admin`);
}
bootstrap();
