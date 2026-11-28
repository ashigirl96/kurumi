import { Database } from "bun:sqlite"
const db = new Database(":memory:"); db.run("PRAGMA foreign_keys = ON")
db.run("CREATE TABLE inbound_messages (id INTEGER PRIMARY KEY, turn_id INTEGER REFERENCES turns(id))")
try { db.run("INSERT INTO inbound_messages (turn_id) VALUES (NULL)"); console.log("insert NULL turn_id before turns exists: ok") } catch (e: any) { console.log("NULL insert:", e.message) }
try { db.run("INSERT INTO inbound_messages (turn_id) VALUES (1)"); console.log("insert turn_id=1 before turns exists: ACCEPTED") } catch (e: any) { console.log("insert turn_id=1 before turns exists:", e.message) }
db.run("CREATE TABLE turns (id INTEGER PRIMARY KEY)"); db.run("INSERT INTO turns VALUES (1)")
db.run("INSERT INTO inbound_messages (turn_id) VALUES (1)"); console.log("after turns created: insert turn_id=1 ok")
try { db.run("INSERT INTO inbound_messages (turn_id) VALUES (2)") } catch (e: any) { console.log("turn_id=2:", e.message) }
