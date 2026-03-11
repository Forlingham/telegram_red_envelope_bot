import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class ScashRpcService {
  private readonly rpcClient: AxiosInstance;

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('SCASH_RPC_URL');
    const rpcUser = this.configService.get<string>('SCASH_RPC_USER');
    const rpcPass = this.configService.get<string>('SCASH_RPC_PASS');

    const auth = Buffer.from(`${rpcUser}:${rpcPass}`).toString('base64');

    this.rpcClient = axios.create({
      baseURL: rpcUrl,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
      },
      timeout: 30000,
    });
  }

  async callRpc<T>(method: string, params: any[] = []): Promise<T> {
    const response = await this.rpcClient.post('', {
      jsonrpc: '2.0',
      id: Math.random().toString(36).substring(7),
      method,
      params,
    });

    if (response.data.error) {
      throw new Error(`RPC Error: ${response.data.error.message}`);
    }

    return response.data.result;
  }

  // 区块链信息
  async getBlockchainInfo(): Promise<any> {
    return this.callRpc('getblockchaininfo');
  }

  async getBlockCount(): Promise<number> {
    return this.callRpc('getblockcount');
  }

  async getBlockHash(height: number): Promise<string> {
    return this.callRpc('getblockhash', [height]);
  }

  async getBlock(blockHash: string, verbosity: number = 2): Promise<any> {
    return this.callRpc('getblock', [blockHash, verbosity]);
  }

  async getRawTransaction(txid: string, verbose: boolean = true): Promise<any> {
    return this.callRpc('getrawtransaction', [txid, verbose]);
  }

  // 内存池
  async getMempoolInfo(): Promise<any> {
    return this.callRpc('getmempoolinfo');
  }

  async getRawMempool(): Promise<string[]> {
    return this.callRpc('getrawmempool');
  }

  async getMempoolEntry(txid: string): Promise<any> {
    return this.callRpc('getmempoolentry', [txid]);
  }

  // 钱包相关
  async sendRawTransaction(hexString: string, maxFeeRate?: number): Promise<string> {
    const params: any[] = [hexString];
    if (maxFeeRate !== undefined) {
      params.push(maxFeeRate);
    }
    return this.callRpc('sendrawtransaction', params);
  }

  async testMempoolAccept(rawTxs: string[]): Promise<any> {
    return this.callRpc('testmempoolaccept', [rawTxs]);
  }

  async decodeRawTransaction(hexString: string): Promise<any> {
    return this.callRpc('decoderawtransaction', [hexString]);
  }

  // 生成区块（仅用于 Regtest）
  async generateToAddress(nblocks: number, address: string): Promise<string[]> {
    return this.callRpc('generatetoaddress', [nblocks, address]);
  }

  // 获取 UTXO 集（用于初始化同步）
  async scanTxOutSet(addresses: string[]): Promise<any> {
    return this.callRpc('scantxoutset', ['start', [{ desc: `addr(${addresses.join(',')})` }]]);
  }
}
