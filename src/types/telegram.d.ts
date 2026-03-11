import * as TelegramBot from 'node-telegram-bot-api';

declare module 'node-telegram-bot-api' {
  interface Message {
    red_packet_id?: number;
  }
}
