import { Module } from "@nestjs/common";
import { HomeController } from "./admin.controller";
import { AdminService } from "./services/admin.service";

@Module({
  controllers: [HomeController],
  providers: [AdminService],
})
export class AdminModule {}
