import { Controller, Get, Query, Render } from "@nestjs/common";
import { AdminService } from "./services/admin.service";

@Controller()
export class HomeController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @Render("admin/index")
  async index() {
    const stats = await this.adminService.getDashboardStats();
    const recent = await this.adminService.getRecentActivity(7);
    return { stats, recent, title: "管理后台" };
  }

  @Get("dashboard")
  @Render("admin/dashboard")
  async dashboard() {
    const stats = await this.adminService.getDashboardStats();
    const daily = await this.adminService.getDailyStats(30);
    return { stats, daily, title: "数据概览" };
  }

  @Get("users")
  @Render("admin/users")
  async users(
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "20",
  ) {
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const result = await this.adminService.getUsers(pageNum, limitNum);
    return { ...result, title: "用户管理" };
  }

  @Get("redpackets")
  @Render("admin/redpackets")
  async redpackets(
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "20",
    @Query("status") status?: string,
  ) {
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const result = await this.adminService.getRedPackets(
      pageNum,
      limitNum,
      status,
    );
    return { ...result, title: "红包管理" };
  }

  @Get("claims")
  @Render("admin/claims")
  async claims(
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "20",
  ) {
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const result = await this.adminService.getClaims(pageNum, limitNum);
    return { ...result, title: "领取记录" };
  }

  @Get("transfers")
  @Render("admin/transfers")
  async transfers(
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "20",
    @Query("status") status?: string,
  ) {
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const result = await this.adminService.getTransfers(
      pageNum,
      limitNum,
      status,
    );
    return { ...result, title: "转账记录" };
  }

  @Get("stats")
  @Render("admin/stats")
  async stats() {
    const [redPacketStats, transferStats, topUsers] = await Promise.all([
      this.adminService.getRedPacketStats(),
      this.adminService.getTransferStats(),
      this.adminService.getTopUsers(10),
    ]);
    return {
      redPacketStats,
      transferStats,
      topUsers,
      title: "数据统计",
    };
  }

  @Get("reports")
  @Render("admin/reports")
  async reports(@Query("days") days: string = "30") {
    const daysNum = parseInt(days, 10) || 30;
    const daily = await this.adminService.getDailyStats(daysNum);
    return { daily, days: daysNum, title: "数据报表" };
  }

  @Get("config")
  @Render("admin/config")
  async config() {
    const configs = await this.adminService.getSystemConfig();
    return { configs, title: "系统配置" };
  }
}
