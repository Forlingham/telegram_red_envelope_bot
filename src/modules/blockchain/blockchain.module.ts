import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScashRpcService } from "./services/scash-rpc.service";
import { UtxoIndexerService } from "./services/utxo-indexer.service";
import { UtxoService } from "./services/utxo.service";
import { ZmqService } from "./services/zmq.service";

@Module({
  imports: [ConfigModule],
  providers: [ScashRpcService, UtxoIndexerService, UtxoService, ZmqService],
  exports: [ScashRpcService, UtxoService, ZmqService],
})
export class BlockchainModule {}
