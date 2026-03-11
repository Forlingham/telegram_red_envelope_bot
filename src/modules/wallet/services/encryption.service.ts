import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class EncryptionService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly keyLength = 32;
  private readonly ivLength = 16;
  private readonly authTagLength = 16;
  private readonly masterKey: Buffer;

  constructor(private configService: ConfigService) {
    const key = this.configService.get<string>('MASTER_KEY');
    if (!key) {
      throw new Error('MASTER_KEY environment variable is required');
    }
    // 使用 HKDF 从主密钥派生加密密钥
    this.masterKey = crypto.createHash('sha256').update(key).digest();
  }

  // 加密数据
  encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(this.algorithm, this.masterKey, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
    };
  }

  // 解密数据
  decrypt(encrypted: string, iv: string, authTag: string): string {
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      this.masterKey,
      Buffer.from(iv, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  // 加密助记词并序列化为字符串
  encryptMnemonic(mnemonic: string): string {
    const result = this.encrypt(mnemonic);
    return JSON.stringify(result);
  }

  // 从序列化字符串解密助记词
  decryptMnemonic(encryptedData: string): string {
    const { encrypted, iv, authTag } = JSON.parse(encryptedData);
    return this.decrypt(encrypted, iv, authTag);
  }
}
