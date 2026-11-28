import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { turns } from "@k/turn/schema";

export const inboundMessages = sqliteTable("inbound_messages", {
  id: integer().primaryKey(),
  platformMessageId: text("platform_message_id").notNull().unique(),
  body: text().notNull(),
  turnId: integer("turn_id").references(() => turns.id),
});
