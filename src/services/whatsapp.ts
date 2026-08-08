import axios, { AxiosInstance } from "axios";
import { config } from "@/config";
import { logger } from "@/utils/logger";
import { toWhatsAppPhone } from "@/utils/helpers";

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

    // Everything stored internally uses the local Nigerian format (0803...),
    // but the Cloud API needs the international one. Normalising here covers
    // every send in one place - a local-format recipient still returns 200
    // with a message id, so this failure is invisible without it.
    this.client.interceptors.request.use((req) => {
      if (req.data && typeof req.data === "object" && "to" in req.data) {
        req.data.to = toWhatsAppPhone(String(req.data.to));
      }
      return req;
    });

    // A real send always echoes back a message id. Anything else (e.g. the
    // bare {"success":true} returned when posting to the wrong node) means
    // nothing was delivered, so surface it as an error instead of "sent".
    this.client.interceptors.response.use((res) => {
      const sentMessage = res.config.data && String(res.config.data).includes('"type"');
      if (sentMessage && !res.data?.messages?.[0]?.id) {
        throw new Error(
          `WhatsApp accepted the request but returned no message id: ${JSON.stringify(res.data)}`
        );
      }
      return res;
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
      const { data } = await this.client.post("/messages", payload);
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
      const { data } = await this.client.post("/messages", payload);
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
      const { data } = await this.client.post("/messages", payload);
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

  async sendFlowMessage(
    to: string,
    bodyText: string,
    flowId: string,
    buttonText: string
  ): Promise<boolean> {
    try {
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "flow",
          body: { text: bodyText },
          action: {
            name: "flow",
            parameters: {
              flow_id: flowId,
              flow_cta: buttonText,
              flow_message_version: "3",
              flow_action: "navigate",
            },
          },
        },
      };
      const { data } = await this.client.post("/messages", payload);
      logger.info(`Flow message sent to ${to}`, { messageId: data.messages?.[0]?.id });
      return true;
    } catch (error: any) {
      logger.error("Failed to send flow message", {
        to,
        error: error.response?.data || error.message,
      });
      return false;
    }
  }

  /**
   * @param buttonUrlParam Value for a dynamic URL button, if the template has
   *   one. WhatsApp treats this as the *suffix* appended to the base URL
   *   configured on the template, not a full URL. Templates with a dynamic URL
   *   button are rejected (error 131008) unless this component is supplied.
   */
  async sendTemplate(
    to: string,
    templateName: string,
    params: string[],
    language: string = "en",
    buttonUrlParam?: string
  ): Promise<boolean> {
    try {
      const components: any[] = [
        {
          type: "body",
          parameters: params.map((p) => ({ type: "text", text: p })),
        },
      ];

      if (buttonUrlParam !== undefined) {
        components.push({
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: buttonUrlParam }],
        });
      }

      const payload = {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: language },
          components,
        },
      };
      const { data } = await this.client.post("/messages", payload);
      logger.info(`Template sent to ${to}`, {
        template: templateName,
        messageId: data.messages?.[0]?.id,
      });
      return true;
    } catch (error: any) {
      logger.error("Failed to send template", {
        to,
        template: templateName,
        error: error.response?.data || error.message,
      });
      return false;
    }
  }

  /**
   * Send a template, falling back to plain text if it fails.
   *
   * A template send fails whenever the template is unapproved, paused, or the
   * parameter count doesn't match its definition. Without a fallback the user
   * gets nothing at all, so the flow dead-ends silently.
   */
  async sendTemplateOrText(
    to: string,
    templateName: string,
    params: string[],
    language: string,
    fallbackText: string,
    buttonUrlParam?: string
  ): Promise<boolean> {
    const sent = await this.sendTemplate(to, templateName, params, language, buttonUrlParam);
    if (sent) return true;

    logger.warn("Template failed, falling back to text message", {
      to,
      template: templateName,
    });
    return this.sendTextMessage(to, fallbackText);
  }

  async markAsRead(messageId: string): Promise<void> {
    try {
      await this.client.post("/messages", {
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
