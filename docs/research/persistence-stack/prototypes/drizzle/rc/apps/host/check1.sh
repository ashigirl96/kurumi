set -e
cd "$(dirname "$0")"
rm -rf drizzle kurumi.db kurumi.db-*
cp ../../packages/turn/src/schema.ts.orig ../../packages/turn/src/schema.ts
echo "## generate init"; bunx drizzle-kit generate --name init 2>&1 | grep -E '✓|No schema'
echo "## apply on fresh file"; bun migrate.ts kurumi.db
echo "## apply again"; bun migrate.ts kurumi.db
echo "## add column turns.prompt_uuid, generate"
sed -i '' 's|state: text({ enum: turnStates }).notNull(),|state: text({ enum: turnStates }).notNull(),\n    promptUuid: text("prompt_uuid"),|' ../../packages/turn/src/schema.ts
sleep 1
bunx drizzle-kit generate --name add_prompt_uuid 2>&1 | grep -E '✓|No schema'
cat drizzle/*_add_prompt_uuid/migration.sql; echo
echo "## apply second"; bun migrate.ts kurumi.db
echo "## generate again with no change"; bunx drizzle-kit generate 2>&1 | grep -E '✓|No schema|nothing'
echo "## tree"; find drizzle -type f | sort
