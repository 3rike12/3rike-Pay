import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { logger } from "../utils/logger";

class WhatsAppService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.whatsapp.apiBase,
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });
  }

  async sendTextMessage(to: string, text: string): Promise<boolean> {
    try {
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: text },
      };
      const { data } = await this.client.post("/", payload);
      logger.info(`Message sent to ${to}`, { messageId: data.messages?.[0]?.id });
      return true;
    } catch (error: any) {
      logger.error("Failed to send WhatsApp message", {
        to,
        error: error.response?.data || error.message,
      });
      return false;
    }
  }

  async sendButtonsMessage(
    to: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<boolean> {
    try {
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.map((btn) => ({
              type: "reply",
              reply: { id: btn.id, title: btn.title },
            })),
          },
        },
      };
      const { data } = await this.client.post("/", payload);
      logger.info(`Buttons sent to ${to}`, { messageId: data.messages?.[0]?.id });
      return true;
    } catch (error: any) {
      logger.error("Failed to send buttons", {
        to,
        error: error.response?.data || error.message,
      });
      return false;
    }
  }

  async sendListMessage(
    to: string,
    bodyText: string,
    buttonText: string,
    sections: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>
  ): Promise<boolean> {
    try {
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: bodyText },
          action: { button: buttonText, sections },
        },
      };
      const { data } = await this.client.post("/", payload);
      logger.info(`List sent to ${to}`, { messageId: data.messages?.[0]?.id });
      return true;
    } catch (error: any) {
      logger.error("Failed to send list", {
        to,
        error: error.response?.data || error.message,
      });
      return false;
    }
  }

  async markAsRead(messageId: string): Promise<void> {
    try {
      await this.client.post("/", {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      });
    } catch (error: any) {
      logger.error("Failed to mark as read", { messageId });
    }
  }
}

export const whatsapp = new WhatsAppService();
