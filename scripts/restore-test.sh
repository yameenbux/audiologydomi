#!/bin/sh
# Restore test: dump Domi's schemas from the live database, restore them into an empty Postgres on this throwaway
# machine, and compare every table's row count. Prints counts and timings only, never data.
set -e
say() { echo "RESTORE $*"; }
body=$(printf '%s' "$DATABASE_CA_CERT" | sed 's/-----BEGIN CERTIFICATE-----//; s/-----END CERTIFICATE-----//' | tr -d ' \n\r\t')
{ echo "-----BEGIN CERTIFICATE-----"; echo "$body" | fold -w64; echo "-----END CERTIFICATE-----"; } > /tmp/ca.pem
export PGSSLMODE=verify-full PGSSLROOTCERT=/tmp/ca.pem
COUNTS="select table_schema||'.'||table_name||' '||(xpath('/row/c/text()', query_to_xml('select count(*) as c from '||quote_ident(table_schema)||'.'||quote_ident(table_name), false, true, '')))[1]::text from information_schema.tables where (table_schema = 'domi' or table_schema like 'p\_%') and table_type = 'BASE TABLE' order by 1"
t0=$(date +%s)
pg_dump "$DATABASE_URL" --schema=domi --schema='p_*' --no-owner --no-privileges -Fc -f /tmp/domi.dump
t1=$(date +%s)
say "dump: $(du -h /tmp/domi.dump | cut -f1) in $((t1 - t0))s"
psql "$DATABASE_URL" -Atc "$COUNTS" > /tmp/source.txt
mkdir -p /tmp/pg && chown postgres /tmp/pg
su postgres -c "initdb -D /tmp/pg -A trust >/dev/null && pg_ctl -D /tmp/pg -o '-k /tmp -c listen_addresses=' -l /tmp/pg.log start >/dev/null"
unset PGSSLMODE PGSSLROOTCERT
createdb -h /tmp -U postgres restored
t2=$(date +%s)
pg_restore -h /tmp -U postgres -d restored --no-owner --exit-on-error /tmp/domi.dump
t3=$(date +%s)
say "restore into an empty database: $((t3 - t2))s"
psql -h /tmp -U postgres -d restored -Atc "$COUNTS" > /tmp/restored.txt
say "tables: $(wc -l < /tmp/source.txt) live, $(wc -l < /tmp/restored.txt) restored"
while read -r line; do say "  $line"; done < /tmp/restored.txt
if diff /tmp/source.txt /tmp/restored.txt >/dev/null; then say "RESULT: every table restored with the same row count"; else say "RESULT: MISMATCH"; diff /tmp/source.txt /tmp/restored.txt | sed 's/^/RESTORE   /'; fi
rm -f /tmp/domi.dump
