import { PrismaService } from "../src/prisma/prisma.service";
import { EncryptionService } from "../src/modules/wallet/services/encryption.service";
import { ConfigService } from "@nestjs/config";

async function main() {
  const prisma = new PrismaService();
  const configService = new ConfigService();
  const encryptionService = new EncryptionService(configService);

  const mnemonic =
    "catch flame party diagram coral jump mother dizzy amateur apple final canoe jaguar session photo soon fix fiscal cousin abstract rich marble census burst";
  const address = "bcrt1q8vdrfmwd4gmu23phh2t8xgutulu9ht2njefl9c";

  // 加密助记词
  const encryptedMnemonic = encryptionService.encryptMnemonic(mnemonic);

  console.log("Encrypted mnemonic:", encryptedMnemonic);

  // 更新钱包记录
  await prisma.wallet.update({
    where: { address },
    data: {
      encryptedMnemonic,
      derivationPath: "m/84'/0'/0'/0/0",
    },
  });

  console.log("Wallet updated successfully");

  await prisma.$disconnect();
}

main().catch(console.error);
