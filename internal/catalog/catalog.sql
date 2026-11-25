WITH RECURSIVE
rels AS (
  SELECT c.oid,c.relname,n.nspname,c.relkind FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f')
    AND CASE WHEN $1::text[] IS NULL THEN n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND NOT(n.nspname=ANY($2::text[])) ELSE n.nspname=ANY($1) END
    AND NOT EXISTS(SELECT FROM pg_depend x WHERE x.classid='pg_class'::regclass AND x.objid=c.oid AND x.deptype='e')
),
cols AS (
  SELECT a.attrelid,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS typename
  FROM pg_attribute a JOIN rels r ON r.oid=a.attrelid WHERE a.attnum>0 AND NOT a.attisdropped
),
cons AS (
  SELECT c.*,r.nspname FROM pg_constraint c JOIN rels r ON r.oid=c.conrelid
  WHERE (c.contype IN ('p','u','c','x','n') OR (c.contype='f' AND $3 AND c.confrelid IN (SELECT oid FROM rels)))
    AND NOT EXISTS(SELECT FROM pg_depend x WHERE x.classid='pg_constraint'::regclass AND x.objid=c.oid AND x.deptype='e')
),
fk AS (
  SELECT c.*,'fk:['||conrelid::text||','||to_json(conname)::text||']' AS id FROM cons c WHERE contype='f'
),
idx AS (
  SELECT i.indexrelid AS oid,i.indrelid,i.indkey,i.indnkeyatts,c.relname,r.nspname
  FROM pg_index i JOIN rels r ON r.oid=i.indrelid JOIN pg_class c ON c.oid=i.indexrelid
  WHERE NOT EXISTS(SELECT FROM pg_constraint k WHERE k.conindid=i.indexrelid AND k.contype IN ('p','u','x'))
    AND NOT EXISTS(SELECT FROM pg_depend x WHERE x.classid='pg_class'::regclass AND x.objid=c.oid AND x.deptype='e')
),
trg AS (
  SELECT t.*,r.nspname FROM pg_trigger t JOIN rels r ON r.oid=t.tgrelid
  WHERE NOT t.tgisinternal AND NOT EXISTS(SELECT FROM pg_depend x WHERE x.classid='pg_trigger'::regclass AND x.objid=t.oid AND x.deptype='e')
),
policies AS (
  SELECT p.*,r.nspname,r.relname FROM pg_policy p JOIN rels r ON r.oid=p.polrelid
  WHERE NOT EXISTS(SELECT FROM pg_depend x WHERE x.classid='pg_policy'::regclass AND x.objid=p.oid AND x.deptype='e')
),
policy_deps AS (
  SELECT p.oid,d.refclassid,d.refobjid,d.refobjsubid FROM policies p
  JOIN pg_depend d ON d.classid='pg_policy'::regclass AND d.objid=p.oid AND d.deptype IN ('a','n')
  WHERE NOT(d.refclassid='pg_class'::regclass AND d.refobjid=p.polrelid AND d.refobjsubid=0)
),
vdeps AS (
  SELECT w.ev_class,d.refclassid,d.refobjid,d.refobjsubid FROM pg_rewrite w JOIN rels v ON v.oid=w.ev_class
  JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=w.oid
  WHERE w.rulename='_RETURN' AND v.relkind IN ('v','m') AND d.deptype='n'
    AND NOT(d.refclassid='pg_class'::regclass AND w.ev_class=d.refobjid)
),
defaults AS (
  SELECT a.adrelid,a.adnum,d.refclassid,d.refobjid,d.refobjsubid FROM pg_attrdef a JOIN rels r ON r.oid=a.adrelid
  JOIN pg_depend d ON d.classid='pg_attrdef'::regclass AND d.objid=a.oid AND d.deptype IN ('n','a')
  WHERE NOT(d.refclassid='pg_class'::regclass AND d.refobjid=a.adrelid AND d.refobjsubid=a.adnum)
    AND NOT EXISTS(SELECT FROM pg_depend x WHERE x.classid='pg_attrdef'::regclass AND x.objid=a.oid AND x.deptype='e')
),
-- Catalog references that bring routines from outside the requested schemas into scope.
direct_calls(source,kind,func) AS (
  SELECT 'r'||ev_class,'calls',refobjid FROM vdeps WHERE refclassid='pg_proc'::regclass
  UNION ALL SELECT 'p'||oid,'calls',refobjid FROM policy_deps WHERE refclassid='pg_proc'::regclass
  UNION ALL SELECT 'g'||oid,'executes',tgfoid FROM trg
  UNION ALL SELECT 'c'||adrelid||'_'||adnum,'default',refobjid FROM defaults WHERE refclassid='pg_proc'::regclass
  UNION ALL SELECT 'k'||k.oid,'calls',d.refobjid FROM cons k JOIN pg_depend d
    ON d.classid='pg_constraint'::regclass AND d.objid=k.oid AND d.refclassid='pg_proc'::regclass AND d.deptype='n' WHERE k.contype<>'f'
  UNION ALL SELECT 'i'||i.oid,'calls',d.refobjid FROM idx i JOIN pg_depend d
    ON d.classid='pg_class'::regclass AND d.objid=i.oid AND d.refclassid='pg_proc'::regclass AND d.deptype='n'
),
permitted AS (
  SELECT p.oid,n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN ('f','p')
   AND NOT EXISTS(SELECT FROM pg_depend x WHERE x.classid='pg_proc'::regclass AND x.objid=p.oid AND x.deptype='e')
),
routine_ids(oid) AS (
  SELECT p.oid FROM permitted p WHERE
    (CASE WHEN $1::text[] IS NULL THEN p.nspname !~ '^pg_' AND p.nspname<>'information_schema' AND NOT(p.nspname=ANY($2))
         ELSE p.nspname=ANY($1) END)
    OR (p.oid IN (SELECT func FROM direct_calls) AND (p.nspname NOT IN ('pg_catalog','information_schema') OR p.oid IN (SELECT tgfoid FROM trg)))
  UNION
  SELECT callee.oid FROM routine_ids caller
  JOIN pg_proc p ON p.oid=caller.oid AND /*HAS_SQL_BODY*/
  JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_proc'::regclass AND d.deptype='n'
  JOIN permitted callee ON callee.oid=d.refobjid AND callee.nspname NOT IN ('pg_catalog','information_schema')
),
procs AS (
  SELECT p.*,n.nspname,l.lanname,/*HAS_SQL_BODY*/ AS has_body
  FROM routine_ids r JOIN pg_proc p ON p.oid=r.oid JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
),
-- Keep relation-level dependencies when no more specific column dependency exists.
relation_refs(source,kind,rel,att) AS (
  SELECT 'r'||v.ev_class,'selects',v.refobjid,v.refobjsubid FROM vdeps v WHERE v.refclassid='pg_class'::regclass
  UNION ALL SELECT 'p'||oid,'reads',refobjid,refobjsubid FROM policy_deps WHERE refclassid='pg_class'::regclass
  UNION ALL SELECT 'f'||p.oid,'reads',d.refobjid,d.refobjsubid FROM procs p JOIN pg_depend d
    ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_class'::regclass AND d.deptype='n' WHERE p.has_body
),
precise_refs AS (
  SELECT source,kind,rel,att,max(att) OVER (PARTITION BY source,kind,rel) AS max_att
  FROM relation_refs JOIN rels ON rel=rels.oid
),
index_keys AS (
  SELECT i.oid,i.indrelid,k.att FROM idx i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(att,pos)
  WHERE k.pos<=i.indnkeyatts AND k.att>0
),
edges(kind,source,target) AS (
  SELECT kind,source,CASE WHEN att=0 THEN 'r'||rel ELSE 'c'||rel||'_'||att END FROM precise_refs WHERE att>0 OR max_att=0
  UNION SELECT d.kind,d.source,'f'||d.func FROM direct_calls d JOIN procs p ON p.oid=d.func
  UNION SELECT 'calls','f'||p.oid,'f'||d.refobjid FROM procs p JOIN pg_depend d
    ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_proc'::regclass AND d.deptype='n'
    JOIN procs callee ON callee.oid=d.refobjid WHERE p.has_body
  UNION SELECT 'default','c'||a.adrelid||'_'||a.adnum,CASE WHEN a.refobjsubid>0 THEN 'c'||r.oid||'_'||a.refobjsubid ELSE 'r'||r.oid END
    FROM defaults a JOIN rels r ON r.oid=a.refobjid WHERE a.refclassid='pg_class'::regclass
  UNION SELECT 'constrains','k'||k.oid,'c'||k.conrelid||'_'||att FROM cons k CROSS JOIN LATERAL unnest(k.conkey) att WHERE k.contype<>'f' AND att>0
  UNION SELECT 'update-of','g'||t.oid,'c'||t.tgrelid||'_'||att FROM trg t CROSS JOIN LATERAL unnest(t.tgattr) att
  UNION SELECT 'indexes','i'||k.oid,'c'||k.indrelid||'_'||k.att FROM index_keys k
  UNION SELECT 'reads','i'||i.oid,'c'||i.indrelid||'_'||d.refobjsubid FROM idx i JOIN pg_depend d
    ON d.classid='pg_class'::regclass AND d.objid=i.oid AND d.refclassid='pg_class'::regclass AND d.refobjid=i.indrelid AND d.refobjsubid>0
    WHERE NOT EXISTS(SELECT FROM index_keys k WHERE k.oid=i.oid AND k.att=d.refobjsubid)
),
objects(id,schema,name,kind,parent,detail,sql) AS (
  SELECT 'r'||oid,nspname,relname,CASE relkind WHEN 'f' THEN 'foreign' WHEN 'm' THEN 'matview' WHEN 'v' THEN 'view' ELSE 'table' END,
    NULL::text,NULL::text,CASE WHEN relkind IN ('v','m') THEN pg_get_viewdef(oid,true) END FROM rels
  UNION ALL SELECT 'k'||oid,nspname,conname,'constraint','r'||conrelid,pg_get_constraintdef(oid,true),NULL FROM cons WHERE contype<>'f'
  -- Read the flags through JSON because PostgreSQL 16 and 17 lack these columns.
  UNION ALL SELECT id,nspname,conname,'constraint','r'||conrelid,
    CASE WHEN to_jsonb(f)->>'conperiod'='true' OR to_jsonb(f)->>'conenforced'='false'
      THEN pg_get_constraintdef(oid,true) ELSE 'FOREIGN KEY' END,NULL FROM fk f
  UNION ALL SELECT 'i'||oid,nspname,relname,'index','r'||indrelid,NULL,pg_get_indexdef(oid,0,true) FROM idx
  UNION ALL SELECT 'p'||oid,nspname,polname,'policy','r'||polrelid,NULL,
    format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s',polname,nspname,relname,
      CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      CASE polcmd WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END,
      (SELECT string_agg(CASE WHEN role_id=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(role_id)) END, ', ' ORDER BY pos)
       FROM unnest(polroles) WITH ORDINALITY AS roles(role_id,pos)))
    || coalesce(' USING ('||pg_get_expr(polqual,polrelid)||')','')
    || coalesce(' WITH CHECK ('||pg_get_expr(polwithcheck,polrelid)||')','') FROM policies
  UNION ALL SELECT 'g'||oid,nspname,tgname,'trigger','r'||tgrelid,
    concat_ws(' ',CASE WHEN tgtype&2<>0 THEN 'BEFORE' WHEN tgtype&64<>0 THEN 'INSTEAD OF' ELSE 'AFTER' END,
      concat_ws(' OR ',CASE WHEN tgtype&4<>0 THEN 'INSERT' END,CASE WHEN tgtype&8<>0 THEN 'DELETE' END,
        CASE WHEN tgtype&16<>0 THEN 'UPDATE' END,CASE WHEN tgtype&32<>0 THEN 'TRUNCATE' END),
      CASE WHEN tgtype&1<>0 THEN 'ROW' ELSE 'STATEMENT' END),NULL FROM trg
)
SELECT 'object' AS category, jsonb_build_object('id',id,'schema',schema,'name',name,'kind',kind,'parentId',parent,'detail',detail,'sql',sql) AS data FROM objects
UNION ALL SELECT 'column',jsonb_build_object('id','c'||attrelid||'_'||attnum,'objectId','r'||attrelid,'name',attname,'type',typename,'position',attnum) FROM cols
UNION ALL SELECT 'routine',jsonb_build_object('id','f'||oid,'schema',nspname,'name',proname,'args',pg_get_function_identity_arguments(oid),
  'inputCount',pronargs,'defaultCount',pronargdefaults,'argModes',proargmodes,'argNames',proargnames,
  'inputTypes',proargtypes::text,
  'searchPath',(SELECT ARRAY(
    SELECT CASE WHEN m[1] IS NULL THEN lower(m[2]) ELSE replace(m[1],'""','"') END
    FROM regexp_matches(o.option_value,'"((?:[^"]|"")*)"|([^",[:space:]]+)','g') WITH ORDINALITY AS token(m,pos)
    ORDER BY pos
  ) FROM pg_options_to_table(proconfig) o WHERE o.option_name='search_path'),
  'returns',format_type(prorettype,NULL),'body',prosrc,'language',lanname,'kind',prokind,'hasSQLBody',has_body,
  'definition',CASE WHEN lanname IN ('sql','plpgsql') THEN pg_get_functiondef(oid) END) FROM procs
UNION ALL SELECT 'edge',jsonb_build_object('id',kind||'|'||source||'|'||target,'kind',kind,'source',source,'target',target,'provenance','catalog') FROM edges
UNION ALL SELECT 'edge',jsonb_build_object('id',f.id||':'||(k.pos-1),'kind','fk','source','c'||f.conrelid||'_'||k.att,
  'target','c'||f.confrelid||'_'||f.confkey[k.pos],'constraintId',f.id,'position',k.pos,'provenance','catalog')
  FROM fk f CROSS JOIN LATERAL unnest(f.conkey) WITH ORDINALITY AS k(att,pos)
