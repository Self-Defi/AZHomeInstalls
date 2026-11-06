#!/usr/bin/env python3
"""Offline D1 schema reconciliation; never opens a network connection.
Production SQL capture is read-only. Backup SQL is restored only to a new local DB.
"""
import argparse, hashlib, json, os, re, sqlite3, sys, subprocess
from pathlib import Path
os.umask(0o077)
ROOT=Path(os.environ.get('AHI_REPO',str(Path.cwd().parent)))
MIGRATIONS=ROOT/'cloudflare/migrations'
BACKUP_SHA='d62296e985cdfd33b43d8559cd0871b30eb1af9aa0c99511e0c73674510e9172'
KNOWN_COUNTS={'outbound_prospects_v2':103,'outbound_messages_v2':275,'outbound_enrollments_v2':93,'email_suppressions':5,'outbound_events_v2':375,'leads':9}
SCHEMA_SQL="""
SELECT 'objects' section, json_group_array(json_object('type',type,'name',name,'table',tbl_name,'sql',sql)) payload FROM (SELECT * FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger','view') ORDER BY type,name)
;
SELECT 'columns' section,json_group_array(json_object('table',t.name,'cid',p.cid,'name',p.name,'type',p.type,'notnull',p.[notnull],'default',p.dflt_value,'pk',p.pk,'hidden',p.hidden)) payload FROM (SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name) t JOIN pragma_table_xinfo(t.name) p
;
SELECT 'foreign_keys' section,json_group_array(json_object('table',t.name,'id',p.id,'seq',p.seq,'target',p.[table],'from',p.[from],'to',p.[to],'on_update',p.on_update,'on_delete',p.on_delete,'match',p.match)) payload FROM (SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name) t JOIN pragma_foreign_key_list(t.name) p
;
SELECT 'indexes' section,json_group_array(json_object('table',t.name,'name',i.name,'unique',i.[unique],'origin',i.origin,'partial',i.partial)) payload FROM (SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name) t JOIN pragma_index_list(t.name) i
;
SELECT 'index_columns' section,json_group_array(json_object('table',t.name,'index',i.name,'seqno',x.seqno,'cid',x.cid,'name',x.name,'desc',x.[desc],'coll',x.coll,'key',x.[key])) payload FROM (SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name) t JOIN pragma_index_list(t.name) i JOIN pragma_index_xinfo(i.name) x
;
SELECT 'table_options' section,json_group_array(json_object('name',name,'type',type,'ncol',ncol,'wr',wr,'strict',strict)) payload FROM (SELECT * FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name);
"""
def qi(value):return '"'+value.replace('"','""')+'"'
def write(path,value):
 path=Path(path);path.write_text(json.dumps(value,indent=2,sort_keys=True)+'\n')
def snapshot(db):return {section:json.loads(payload or '[]') for statement in SCHEMA_SQL.split(';') if statement.strip() for section,payload in db.execute(statement)}
def norm_sql(sql):
 if sql is None:return None
 # Preserve literal values; ignore formatting/comments and quoted identifier spelling.
 tokens=re.findall(r"--[^\n]*|/\*[\s\S]*?\*/|'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[^\s]",sql)
 result=[];i=0
 while i<len(tokens):
  t=tokens[i]
  if t.startswith('--') or t.startswith('/*'):i+=1;continue
  if [x.upper() for x in tokens[i:i+3]]==['IF','NOT','EXISTS']:i+=3;continue
  if t.startswith("'"):result.append(t)
  elif t.startswith(('"','`','[')):result.append(t[1:-1].replace('""','"').upper())
  else:result.append(t.upper())
  i+=1
 return ' '.join(result)
def optional_runtime_schema(expected):
 db=sqlite3.connect(':memory:')
 for kind in ['table','index']:
  for row in expected['objects']:
   if row['type']==kind:db.execute(row['sql'])
 source=(ROOT/'cloudflare/estimate-worker.js').read_text()
 for table,index in [('estimate_responses','idx_estimate_responses_token_hash'),('installation_slots','idx_installation_slots_start')]:
  db.execute(re.search(r'`(CREATE TABLE IF NOT EXISTS '+table+r'\b[\s\S]*?)`',source).group(1))
  db.execute(re.search(r'"(CREATE INDEX IF NOT EXISTS '+index+r'[^"\n]*)"',source).group(1))
 return snapshot(db)
def comparison(expected,actual):
 original_keys={(r['type'],r['name']) for r in expected['objects']}
 runtime=optional_runtime_schema(expected)
 optional_tables=({'estimate_responses','installation_slots'} & {r['name'] for r in actual['objects'] if r['type']=='table'})-{r['name'] for r in expected['objects'] if r['type']=='table'}
 expected={section:list(rows) for section,rows in expected.items()}
 for section,rows in runtime.items():
  expected[section].extend(row for row in rows if (row.get('table') or row.get('name')) in optional_tables)
 eo={(r['type'],r['name']):r for r in expected['objects']};ao={(r['type'],r['name']):r for r in actual['objects']}
 diffs=[]
 for key in eo.keys()-original_keys:
  if key in ao and norm_sql(eo[key]['sql'])==norm_sql(ao[key]['sql']):diffs.append({'object':key,'classification':'Compatible historical difference','detail':'Exact repository runtime-created CRM/scheduling object; all structural metadata is still compared.'})
 for key,obj in eo.items():
  if key not in ao:diffs.append({'object':key,'classification':'Missing object'});continue
  if norm_sql(obj['sql'])!=norm_sql(ao[key]['sql']):diffs.append({'object':key,'classification':'Requires investigation','detail':'DDL differs; inspect CHECK, UNIQUE, collation, defaults and constraints; equivalence is not assumed.'})
 if ('table','d1_migrations') in ao:
  tracking=ao[('table','d1_migrations')]
  variants=["CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)","CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"]
  valid_tracking=False
  for ddl in variants:
   local=sqlite3.connect(':memory:');local.execute(ddl);reference=snapshot(local)
   if norm_sql(ddl)!=norm_sql(tracking['sql']):continue
   valid_tracking=True
   for section in ['columns','foreign_keys','indexes','index_columns','table_options']:
    observed=sorted((r for r in actual[section] if (r.get('table') or r.get('name'))=='d1_migrations'),key=lambda x:json.dumps(x,sort_keys=True))
    if observed!=sorted(reference[section],key=lambda x:json.dumps(x,sort_keys=True)):valid_tracking=False
  if not valid_tracking:diffs.append({'object':['table','d1_migrations'],'classification':'Requires investigation','detail':'Tracking definition/constraints/indexes differ from both the reported table and Wrangler 4.158.0 standard. Do not assume inserts/listing are compatible.'})
 else:diffs.append({'object':['table','d1_migrations'],'classification':'Missing object','detail':'Reported production tracking table was not found.'})
 for key in ao.keys()-eo.keys():
  if key==('table','d1_migrations'):
   diffs.append({'object':key,'classification':'Compatible historical difference','detail':'Wrangler metadata table; inspect separately. Not part of business migrations.'})
  elif key[0]=='index' and ao[key]['table']=='d1_migrations':
   diffs.append({'object':key,'classification':'Compatible historical difference','detail':'Wrangler tracking-table index; inspect separately.'})
  else:diffs.append({'object':key,'classification':'Requires investigation','detail':'Additional object not defined by migrations 0001–0006. Retain; establish provenance and interactions.'})
 for section in ['columns','foreign_keys','indexes','index_columns','table_options']:
  def select(data):return sorted((row for row in data[section] if (row.get('table') or row.get('name')) in {name for typ,name in eo if typ=='table'}),key=lambda x:json.dumps(x,sort_keys=True))
  if select(expected)!=select(actual):diffs.append({'object':section,'classification':'Conflicting definition','expected':select(expected),'actual':select(actual)})
 return {'differences':diffs,'expected_objects':len(eo),'schema_gate':not any(d['classification'] in ['Missing object','Conflicting definition','Requires investigation'] for d in diffs),'matches':sorted([list(k) for k in eo if k in ao and norm_sql(eo[k]['sql'])==norm_sql(ao[k]['sql'])])}
def table_names(db):return [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'d1_migrations' ORDER BY name")]
def counts(db):return {name:db.execute('SELECT COUNT(*) FROM '+qi(name)).fetchone()[0] for name in table_names(db)}
def digest(db,name,columns):
 h=hashlib.sha256()
 for row in db.execute('SELECT '+','.join(map(qi,columns))+' FROM '+qi(name)+' ORDER BY '+','.join(map(qi,columns))):
  encoded=json.dumps(row,separators=(',',':'),default=lambda x:{'blob_hex':x.hex()},ensure_ascii=False).encode();h.update(len(encoded).to_bytes(8,'big'));h.update(encoded)
 return h.hexdigest()
def offline_migration_test(db,out):
 before=counts(db);columns={name:[r[1] for r in db.execute('PRAGMA table_xinfo('+qi(name)+')') if r[6]==0] for name in before}
 hashes={name:digest(db,name,cols) for name,cols in columns.items()}
 fk_before=db.execute('SELECT COUNT(*) FROM pragma_foreign_key_check').fetchone()[0]
 integrity_before=db.execute('PRAGMA integrity_check').fetchall()
 candidates=db.execute("SELECT COUNT(*) FROM outbound_messages_v2 WHERE step=0 AND sent_at IS NULL AND (status='claimed' OR last_error LIKE '%uncertain%')").fetchone()[0]
 malformed=db.execute("SELECT COUNT(*) FROM outbound_messages_v2 WHERE step=0 AND sent_at IS NULL AND (status='claimed' OR last_error LIKE '%uncertain%') AND date(claimed_until,'-10 minutes','-7 hours') IS NULL").fetchone()[0]
 if fk_before or integrity_before!=[('ok',)]:raise ValueError('Pre-migration integrity/FK failure; no local migration attempted')
 day_before=db.execute("SELECT date('now','-7 hours')").fetchone()[0]
 sequences_before=db.execute("SELECT name,seq FROM sqlite_sequence WHERE name<>'d1_migrations' ORDER BY name").fetchall()
 migration=(MIGRATIONS/'0007_outbound_reliability.sql').read_text()
 db.executescript('BEGIN IMMEDIATE;\n'+migration+"\nINSERT INTO d1_migrations(name) VALUES('0007_outbound_reliability.sql');\nCOMMIT;")
 preserved={name:db.execute('SELECT COUNT(*) FROM '+qi(name)).fetchone()[0]==before[name] and digest(db,name,cols)==hashes[name] for name,cols in columns.items()}
 exact_backfill=db.execute("""WITH expected AS (SELECT id message_id,COALESCE(date(claimed_until,'-10 minutes','-7 hours'),date('now','-7 hours')) phoenix_date,'legacy-uncertain' owner,COALESCE(claimed_until,strftime('%Y-%m-%dT%H:%M:%fZ','now')) reserved_at FROM outbound_messages_v2 WHERE step=0 AND sent_at IS NULL AND (status='claimed' OR last_error LIKE '%uncertain%')) SELECT COUNT(*) FROM (SELECT message_id,phoenix_date,owner FROM expected EXCEPT SELECT message_id,phoenix_date,owner FROM outbound_introduction_reservations)""").fetchone()[0]==0
 result={'scope':'isolated local database only','before_counts':before,'existing_row_projections_preserved':preserved,'integrity_after':[r[0] for r in db.execute('PRAGMA integrity_check')],'foreign_key_violations_after':db.execute('SELECT COUNT(*) FROM pragma_foreign_key_check').fetchone()[0],'backfill_expected':candidates,'backfill_actual':db.execute('SELECT COUNT(*) FROM outbound_introduction_reservations').fetchone()[0],'backfill_id_day_owner_match':exact_backfill,'fallback_day_candidates':malformed,'migration_tracking':[r[0] for r in db.execute('SELECT name FROM d1_migrations ORDER BY id')]}
 result['same_phoenix_day']=db.execute("SELECT date('now','-7 hours')").fetchone()[0]==day_before
 result['business_autoincrement_sequences_preserved']=db.execute("SELECT name,seq FROM sqlite_sequence WHERE name<>'d1_migrations' ORDER BY name").fetchall()==sequences_before
 result['passed']=result['same_phoenix_day'] and result['business_autoincrement_sequences_preserved'] and all(preserved.values()) and result['integrity_after']==['ok'] and result['foreign_key_violations_after']==0 and candidates==result['backfill_actual'] and exact_backfill
 write(out/'migration-0007-test.json',result);write(out/'schema-after-0007.json',snapshot(db))
 if not result['passed']:raise ValueError('Local migration preservation/backfill validation failed')
 return result
def expected_databases(out):
 db=sqlite3.connect(':memory:');db.execute('PRAGMA foreign_keys=ON')
 summary=[];previous=set()
 for path in sorted(MIGRATIONS.glob('000[1-6]_*.sql')):
  db.executescript(path.read_text());snap=snapshot(db);write(out/(path.stem+'-schema.json'),snap)
  objs={(r['type'],r['name']) for r in snap['objects']};summary.append({'migration':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'new_objects':sorted(objs-previous),'table_count':len(table_names(db))});previous=objs
 write(out/'migration-analysis.json',summary);write(out/'expected-after-0006.json',snapshot(db));write(out/'optional-runtime-schema.json',optional_runtime_schema(snapshot(db)))
 (out/'schema-inspection.sql').write_text(SCHEMA_SQL)
 (out/'expected-schema-0006.sql').write_text('\n'.join(path.read_text() for path in sorted(MIGRATIONS.glob('000[1-6]_*.sql'))))
 return db
def load_capture(path):
 raw=json.loads(Path(path).read_text());rows=[]
 def visit(value):
  if isinstance(value,dict):
   if 'section' in value and 'payload' in value:rows.append(value)
   elif 'results' in value:visit(value['results'])
   elif 'result' in value:visit(value['result'])
   else:
    for child in value.values():
     if isinstance(child,(dict,list)):visit(child)
  elif isinstance(value,list):
   for item in value:visit(item)
 visit(raw)
 if rows:
  if len(rows)!=6 or {r['section'] for r in rows}!={'objects','columns','foreign_keys','indexes','index_columns','table_options'}:raise ValueError('Schema capture is incomplete or duplicated; all six metadata sections are required')
  return {r['section']:json.loads(r['payload']) if isinstance(r['payload'],str) else r['payload'] for r in rows}
 if all(k in raw for k in ['objects','columns','foreign_keys','indexes','index_columns','table_options']):return raw
 raise ValueError('Not a complete schema capture')
def main():
 global ROOT,MIGRATIONS
 p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,default=ROOT);p.add_argument('--out',type=Path,required=True);p.add_argument('--backup',type=Path);p.add_argument('--production-json',type=Path);args=p.parse_args();ROOT=args.repo.resolve();MIGRATIONS=ROOT/'cloudflare/migrations';
 if args.out.exists() and any(args.out.iterdir()):raise ValueError('Output directory is not empty; use a fresh directory to avoid stale assessments')
 args.out.mkdir(parents=True,exist_ok=True)
 write(args.out/'assessment.json',{'recommendation':'NO-GO','state':'Preconditions not yet verified; no production writes authorized'})
 if subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()!='a5579c3921dfb4840ffc2753bedc162e45ce6eb7':raise ValueError('Repository HEAD differs from reviewed main merge commit; stop')
 subprocess.run(['git','diff','--quiet','HEAD','--','cloudflare/migrations','cloudflare/estimate-worker.js'],cwd=ROOT,check=True)
 if subprocess.check_output(['git','ls-files','--others','--exclude-standard','--','cloudflare/migrations'],cwd=ROOT,text=True).strip():raise ValueError('Unexpected untracked migration files; stop')
 expected_db=expected_databases(args.out);expected=snapshot(expected_db)
 result={'recommendation':'NO-GO','production_comparison':'not supplied','verified_backup_test':'not supplied','source_main': 'a5579c3921dfb4840ffc2753bedc162e45ce6eb7'}
 if args.production_json:
  result['production_comparison']=comparison(expected,load_capture(args.production_json));write(args.out/'production-schema-diff.json',result['production_comparison'])
 if args.backup:
  digest_sha=hashlib.sha256(args.backup.read_bytes()).hexdigest()
  if digest_sha!=BACKUP_SHA:raise ValueError('Backup SHA-256 does not match the operator-verified backup; stop')
  restored=args.out/'restored-backup.sqlite';restored.touch(exist_ok=False);db=sqlite3.connect(restored)
  # SQL restore is confined to the new local DB. Never allow ATTACH or extension loading.
  def authorize(action,a,b,dbname,trigger):
   if action in (sqlite3.SQLITE_ATTACH,sqlite3.SQLITE_DETACH) or action==sqlite3.SQLITE_FUNCTION and (b or '').lower()=='load_extension':return sqlite3.SQLITE_DENY
   return sqlite3.SQLITE_OK
  db.set_authorizer(authorize);db.executescript(args.backup.read_text());db.set_authorizer(None);db.execute('PRAGMA foreign_keys=ON')
  diff=comparison(expected,snapshot(db));write(args.out/'backup-schema-diff.json',diff)
  observed=counts(db);write(args.out/'backup-counts.json',observed)
  if any(observed.get(k)!=v for k,v in KNOWN_COUNTS.items()):raise ValueError('Backup counts differ from the operator-verified counts')
  if not diff['schema_gate']:raise ValueError('Backup schema has unresolved differences; do not baseline or test migration until reviewed')
  history=db.execute('SELECT COUNT(*) FROM d1_migrations').fetchone()[0]
  if history:raise ValueError('Backup history is not empty; requires a separate reviewed plan')
  db.executescript((Path(__file__).parent/'baseline-history.proposed.sql').read_text())
  result['verified_backup_test']=offline_migration_test(db,args.out)
 # A local GO does not authorize writes or independently confirm current production pause/backup freshness.
 if args.backup and args.production_json and result['production_comparison']['schema_gate'] and result['verified_backup_test']['passed']:result['recommendation']='CONDITIONAL GO FOR OPERATOR REVIEW; reverify live pause, backup freshness and next authorization before writes'
 write(args.out/'assessment.json',result)
 print(json.dumps({'recommendation':result['recommendation'],'output_directory':str(args.out),'production_access_used':False}))
if __name__=='__main__':main()
