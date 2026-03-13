import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  async getDashboardStats() {
    const [
      totalUsers,
      totalRedPackets,
      totalClaims,
      totalTransfers,
      activeRedPackets,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.redPacket.count(),
      this.prisma.redPacketClaim.count(),
      this.prisma.poolingTransfer.count(),
      this.prisma.redPacket.count({
        where: { status: "ACTIVE" },
      }),
    ]);

    const totalVolume = await this.prisma.redPacket.aggregate({
      _sum: { totalAmount: true },
    });

    const claimedVolume = await this.prisma.redPacketClaim.aggregate({
      _sum: { amount: true },
    });

    return {
      totalUsers,
      totalRedPackets,
      totalClaims,
      totalTransfers,
      activeRedPackets,
      totalVolume: totalVolume._sum.totalAmount || 0,
      claimedVolume: claimedVolume._sum.amount || 0,
    };
  }

  async getUsers(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: { wallet: true },
      }),
      this.prisma.user.count(),
    ]);

    return {
      users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getRedPackets(page = 1, limit = 20, status?: string) {
    const skip = (page - 1) * limit;
    const where = status ? { status: status as any } : {};

    const [redPackets, total] = await Promise.all([
      this.prisma.redPacket.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          sender: true,
          claims: true,
        },
      }),
      this.prisma.redPacket.count({ where }),
    ]);

    return {
      redPackets,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getClaims(page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [claims, total] = await Promise.all([
      this.prisma.redPacketClaim.findMany({
        skip,
        take: limit,
        orderBy: { claimedAt: "desc" },
        include: {
          user: true,
          redPacket: true,
        },
      }),
      this.prisma.redPacketClaim.count(),
    ]);

    return {
      claims,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getTransfers(page = 1, limit = 20, status?: string) {
    const skip = (page - 1) * limit;
    const where = status ? { status: status as any } : {};

    const [transfers, total] = await Promise.all([
      this.prisma.poolingTransfer.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: { user: true },
      }),
      this.prisma.poolingTransfer.count({ where }),
    ]);

    return {
      transfers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getRecentActivity(days = 7) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [newUsers, newRedPackets, newClaims, newTransfers] =
      await Promise.all([
        this.prisma.user.count({
          where: { createdAt: { gte: startDate } },
        }),
        this.prisma.redPacket.count({
          where: { createdAt: { gte: startDate } },
        }),
        this.prisma.redPacketClaim.count({
          where: { claimedAt: { gte: startDate } },
        }),
        this.prisma.poolingTransfer.count({
          where: { createdAt: { gte: startDate } },
        }),
      ]);

    return {
      newUsers,
      newRedPackets,
      newClaims,
      newTransfers,
      days,
    };
  }

  async getDailyStats(days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const dailyUsers = await this.prisma.$queryRaw`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM users
      WHERE created_at >= ${startDate}
      GROUP BY DATE(created_at)
      ORDER BY date
    `;

    const dailyRedPackets = await this.prisma.$queryRaw`
      SELECT DATE(created_at) as date, COUNT(*) as count, SUM(total_amount::numeric) as volume
      FROM red_packets
      WHERE created_at >= ${startDate}
      GROUP BY DATE(created_at)
      ORDER BY date
    `;

    const dailyClaims = await this.prisma.$queryRaw`
      SELECT DATE(claimed_at) as date, COUNT(*) as count, SUM(amount::numeric) as volume
      FROM red_packet_claims
      WHERE claimed_at >= ${startDate}
      GROUP BY DATE(claimed_at)
      ORDER BY date
    `;

    return {
      dailyUsers,
      dailyRedPackets,
      dailyClaims,
      startDate,
      endDate: new Date(),
    };
  }

  async getRedPacketStats() {
    const byType = await this.prisma.redPacket.groupBy({
      by: ["type"],
      _count: true,
      _sum: { totalAmount: true },
    });

    const byStatus = await this.prisma.redPacket.groupBy({
      by: ["status"],
      _count: true,
    });

    return { byType, byStatus };
  }

  async getTransferStats() {
    const byStatus = await this.prisma.poolingTransfer.groupBy({
      by: ["status"],
      _count: true,
      _sum: { amount: true },
    });

    const byType = await this.prisma.poolingTransfer.groupBy({
      by: ["type"],
      _count: true,
      _sum: { amount: true },
    });

    return { byStatus, byType };
  }

  async getTopUsers(limit = 10) {
    const topSenders = await this.prisma.user.findMany({
      take: limit,
      orderBy: {
        redPacketsSent: { _count: "desc" },
      },
      include: {
        _count: { select: { redPacketsSent: true } },
      },
    });

    const topClaimers = await this.prisma.user.findMany({
      take: limit,
      orderBy: {
        claims: { _count: "desc" },
      },
      include: {
        _count: { select: { claims: true } },
      },
    });

    return { topSenders, topClaimers };
  }

  async getSystemConfig() {
    const configs = await this.prisma.systemConfig.findMany();
    return configs.reduce((acc, config) => {
      acc[config.key] = config.value;
      return acc;
    }, {});
  }

  async updateSystemConfig(key: string, value: string) {
    return this.prisma.systemConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
}
