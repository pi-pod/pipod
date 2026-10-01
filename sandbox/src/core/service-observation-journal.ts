import fs from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import Database from "better-sqlite3";

/** Rehearsal-only signed lifecycle observations. No row describes billable
 * service, a complete interval, or a grant. Never feed this to usage.ts. */
export type ShadowKind="launch-intent"|"launch-returned"|"launch-failed"|"launch-uncertain"|"teardown-returned"|"interrupted";
export class ShadowUncertainExecution extends Error {
  constructor(){super("shadow observation outcome unavailable; execution custody unresolved");this.name="ShadowUncertainExecution";}
}
export type ShadowIdentity={hostId:string;supervisorBootId:string;sandboxId:string;
  ownerKey:string;runtimeGeneration:number;actionId:string;monotonicNs:string;observedWallMs:string};
export type ShadowRecord={sequence:number;eventId:string;actionId:string;kind:ShadowKind;
  payload:string;digest:string;signature:string};
const domain="pi-pod/runtime-shadow-observation-v1\n";
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
const idPattern=/^[A-Za-z0-9._:-]{1,128}$/;

export class ShadowObservationJournal {
  private readonly db:Database.Database;
  private readonly key:KeyObject;
  private volatileHold=false;
  readonly publicKey:string;
  readonly journalId:string;
  readonly keyId:string;
  private readonly markerPath:string;
  private readonly checkpointPath:string;
  private readonly holdPath:string;

  static readonly filename="service-observations.sqlite";
  static readonly markerFilename="service-observations.active";
  static readonly checkpointFilename="service-observations.checkpoint";
  static readonly holdFilename="service-observations.hold";
  static exists(stateDir:string):boolean {
    return [ShadowObservationJournal.filename,ShadowObservationJournal.markerFilename,
      ShadowObservationJournal.checkpointFilename,ShadowObservationJournal.holdFilename]
      .some(name=>fs.existsSync(path.join(stateDir,name)));
  }

  constructor(stateDir:string,keyPath:string,keyId:string){
    if(!idPattern.test(keyId))throw new Error("shadow signing key identity invalid");
    const realState=fs.existsSync(stateDir)?fs.realpathSync(stateDir):path.resolve(stateDir);
    const parent=fs.realpathSync(path.dirname(keyPath));
    if(parent===realState || parent.startsWith(realState+path.sep))
      throw new Error("shadow signing key must be outside tenant state");
    for(let dir=parent;;dir=path.dirname(dir)){
      const stat=fs.statSync(dir);
      if(stat.uid!==0 || (stat.mode&0o022)!==0)
        throw new Error("shadow signing key ancestry must be root-owned and non-writable");
      const next=path.dirname(dir);if(next===dir)break;
    }
    const fd=fs.openSync(keyPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    let secret:Buffer;
    try{
      const keyStat=fs.fstatSync(fd);
      if(!keyStat.isFile() || keyStat.uid!==0 || (keyStat.mode&0o077)!==0)
        throw new Error("shadow signing key must be root-owned and private");
      secret=fs.readFileSync(fd);
    }finally{fs.closeSync(fd)}
    this.key=createPrivateKey(secret);
    secret.fill(0);
    if(this.key.asymmetricKeyType!=="ed25519")throw new Error("shadow signing key must be Ed25519");
    this.publicKey=createPublicKey(this.key).export({type:"spki",format:"pem"}).toString();
    this.keyId=keyId;
    fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
    const databasePath=path.join(stateDir,ShadowObservationJournal.filename);
    this.markerPath=path.join(stateDir,ShadowObservationJournal.markerFilename);
    this.checkpointPath=path.join(stateDir,ShadowObservationJournal.checkpointFilename);
    this.holdPath=path.join(stateDir,ShadowObservationJournal.holdFilename);
    const databaseExists=fs.existsSync(databasePath),markerExists=fs.existsSync(this.markerPath);
    if(databaseExists!==markerExists)throw new Error("shadow journal/sentinel mismatch; preserve state for recovery");
    const proposedId=databaseExists?null:randomUUID();
    if(proposedId)this.writeRootPrivate(this.markerPath,JSON.stringify({journalId:proposedId,keyId,publicKey:this.publicKey})+String.fromCharCode(10));
    this.db=new Database(databasePath);
    this.db.pragma("journal_mode = WAL");this.db.pragma("synchronous = FULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS shadow_meta(journal_id TEXT PRIMARY KEY,key_id TEXT NOT NULL,public_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shadow_events(sequence INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,
        action_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,signature TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS shadow_action_kind ON shadow_events(action_id,kind);
      CREATE TABLE IF NOT EXISTS shadow_holds(reason TEXT NOT NULL,event_id TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,PRIMARY KEY(reason,event_id));`);
    const stored=this.db.prepare("SELECT journal_id,key_id,public_key FROM shadow_meta LIMIT 1")
      .get() as {journal_id:string;key_id:string;public_key:string}|undefined;
    const marker=JSON.parse(this.readRootPrivate(this.markerPath)) as {journalId?:string;keyId?:string;publicKey?:string};
    if(marker.keyId!==keyId || marker.publicKey!==this.publicKey ||
      (stored && (stored.journal_id!==marker.journalId || stored.key_id!==keyId || stored.public_key!==this.publicKey)))
      throw new Error("shadow signing identity/journal sentinel mismatch; preserve state");
    this.journalId=marker.journalId!;
    if(!stored)this.db.prepare("INSERT INTO shadow_meta(journal_id,key_id,public_key) VALUES (?,?,?)")
      .run(this.journalId,keyId,this.publicKey);
    const checkpointExists=fs.existsSync(this.checkpointPath);
    if(databaseExists!==checkpointExists)throw new Error("shadow checkpoint missing; preserve state for recovery");
    if(!checkpointExists)this.writeCheckpoint({sequence:0,digest:"0".repeat(64)});
    else this.verifyCheckpoint();
  }

  private readRootPrivate(file:string):string {
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.uid!==0||(stat.mode&0o077)!==0)
      throw new Error("shadow sentinel must be root-owned and private");return fs.readFileSync(fd,"utf8");}
    finally{fs.closeSync(fd)}
  }
  private writeRootPrivate(file:string,contents:string):void {
    const fd=fs.openSync(file,"wx",0o600);
    try{fs.writeFileSync(fd,contents);fs.fsyncSync(fd);}finally{fs.closeSync(fd)}
    const dir=fs.openSync(path.dirname(file),fs.constants.O_RDONLY);
    try{fs.fsyncSync(dir);}finally{fs.closeSync(dir)}
  }
  private writeCheckpoint(checkpoint:{sequence:number;digest:string}):void {
    const temp=`${this.checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
    this.writeRootPrivate(temp,JSON.stringify(checkpoint)+String.fromCharCode(10));
    fs.renameSync(temp,this.checkpointPath);
    const dir=fs.openSync(path.dirname(this.checkpointPath),fs.constants.O_RDONLY);
    try{fs.fsyncSync(dir);}finally{fs.closeSync(dir)}
  }
  private verifyCheckpoint():void {
    const checkpoint=JSON.parse(this.readRootPrivate(this.checkpointPath)) as {sequence?:number;digest?:string};
    const count=(this.db.prepare("SELECT count(*) AS n FROM shadow_events").get() as {n:number}).n;
    const last=this.db.prepare("SELECT sequence,digest FROM shadow_events ORDER BY sequence DESC LIMIT 1")
      .get() as {sequence:number;digest:string}|undefined;
    if(!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence!==count ||
      (last?.sequence??0)!==checkpoint.sequence || (last?.digest??"0".repeat(64))!==checkpoint.digest)
      throw new Error("shadow journal/checkpoint mismatch; preserve state for reconciliation");
  }

  private canonical(sequence:number,eventId:string,previousDigest:string,kind:ShadowKind,i:ShadowIdentity):string {
    for(const value of [eventId,i.hostId,i.supervisorBootId,i.sandboxId,i.ownerKey,i.actionId])
      if(!idPattern.test(value))throw new Error("shadow observation identity invalid");
    if(!Number.isSafeInteger(i.runtimeGeneration)||i.runtimeGeneration<0 ||
      !/^(0|[1-9][0-9]*)$/.test(i.monotonicNs)||!/^(0|[1-9][0-9]*)$/.test(i.observedWallMs))
      throw new Error("shadow observation clock or generation invalid");
    const payload=JSON.stringify(["runtime-shadow-observation-v1",this.journalId,String(sequence),
      eventId,previousDigest,this.keyId,i.hostId,i.supervisorBootId,i.sandboxId,i.ownerKey,
      String(i.runtimeGeneration),i.actionId,kind,i.monotonicNs,i.observedWallMs]);
    if(Buffer.byteLength(payload)>2048)throw new Error("shadow observation payload too large");
    return payload;
  }

  private verifyChain(hostId:string):void {
    let previous="0".repeat(64),sequence=0;
    const actions=new Map<string,{last:ShadowKind;identity:string[]}>();
    const rows=this.db.prepare(`SELECT sequence,event_id AS eventId,action_id AS actionId,
      kind,payload,digest,signature FROM shadow_events ORDER BY sequence`).all() as ShadowRecord[];
    if(rows.length>1000)throw new Error("shadow journal bound invalid");
    const key=createPublicKey(this.key);
    for(const row of rows){
      const fields=JSON.parse(row.payload) as unknown;
      if(!Array.isArray(fields) || fields.length!==15 || row.sequence!==++sequence ||
        fields[0]!=="runtime-shadow-observation-v1" || fields[1]!==this.journalId ||
        fields[2]!==String(sequence) || fields[3]!==row.eventId || fields[4]!==previous ||
        fields[5]!==this.keyId || fields[6]!==hostId || fields[11]!==row.actionId || fields[12]!==row.kind ||
        row.eventId!==`${row.actionId}:${row.kind}` ||
        sha(domain+row.payload)!==row.digest || !verify(null,Buffer.from(domain+row.payload),key,
          Buffer.from(row.signature,"base64")))throw new Error("shadow journal integrity invalid");
      const identity=[fields[6],fields[8],fields[9],fields[10],fields[11]] as string[];
      const state=actions.get(row.actionId);
      if(!state){if(row.kind!=="launch-intent")throw new Error("shadow action lacks intent");
        actions.set(row.actionId,{last:row.kind,identity});}
      else{
        if(identity.some((value,index)=>value!==state.identity[index]))throw new Error("shadow action identity changed");
        const allowed=state.last==="launch-intent"
          ? ["launch-returned","launch-failed","launch-uncertain","interrupted"]
          : state.last==="launch-returned"?["teardown-returned"]:[];
        if(!allowed.includes(row.kind))throw new Error("shadow action transition invalid");
        actions.set(row.actionId,{last:row.kind,identity});
      }
      previous=row.digest;
    }
  }

  private hold(reason:string,eventId:string):void {
    try{
      if(!fs.existsSync(this.holdPath))this.writeRootPrivate(this.holdPath,
        JSON.stringify({journalId:this.journalId,reason,eventId,at:String(Date.now())})+String.fromCharCode(10));
      this.db.prepare("INSERT OR IGNORE INTO shadow_holds(reason,event_id,recorded_at) VALUES (?,?,?)")
        .run(reason,eventId,Date.now());
    }catch(error){this.volatileHold=true;throw error;}
  }
  markHold(reason:string,id:string):void {this.volatileHold=true;this.hold(reason,id);}
  held():boolean {return this.volatileHold || fs.existsSync(this.holdPath) ||
    Boolean(this.db.prepare("SELECT 1 FROM shadow_holds LIMIT 1").get());}
  count():number {return (this.db.prepare("SELECT count(*) AS n FROM shadow_events").get() as {n:number}).n;}

  append(kind:ShadowKind,i:ShadowIdentity,allowHeld=false):{record:ShadowRecord;replay:boolean}{
    const eventId=`${i.actionId}:${kind}`;
    const run=this.db.transaction(()=>{
      const previous=this.db.prepare(`SELECT sequence,event_id AS eventId,action_id AS actionId,
        kind,payload,digest,signature FROM shadow_events
        WHERE event_id=? OR (action_id=? AND kind=?)`)
        .get(eventId,i.actionId,kind) as ShadowRecord|undefined;
      if(previous){
        const data=JSON.parse(previous.payload) as string[];
        const expected=this.canonical(previous.sequence,eventId,data[4]!,kind,i);
        if(previous.eventId!==eventId || expected!==previous.payload){
          this.hold("observation_identity_conflict",eventId);
          return {conflict:true as const};
        }
        return {record:previous,replay:true as const};
      }
      if(this.held() && !allowHeld)throw new Error("shadow journal held");
      const latest=this.db.prepare("SELECT sequence,digest FROM shadow_events ORDER BY sequence DESC LIMIT 1")
        .get() as {sequence:number;digest:string}|undefined;
      // Reserve room for a terminal observation and an interrupted recovery.
      if((latest?.sequence??0)>=(kind==="launch-intent"?997:1000))
        throw new Error("shadow journal capacity exhausted");
      const sequence=(latest?.sequence??0)+1;
      const payload=this.canonical(sequence,eventId,latest?.digest??"0".repeat(64),kind,i);
      const digest=sha(domain+payload);
      const signature=sign(null,Buffer.from(domain+payload),this.key).toString("base64");
      this.db.prepare(`INSERT INTO shadow_events(sequence,event_id,action_id,kind,payload,digest,signature)
        VALUES (?,?,?,?,?,?,?)`).run(sequence,eventId,i.actionId,kind,payload,digest,signature);
      return {record:{sequence,eventId,actionId:i.actionId,kind,payload,digest,signature},replay:false as const};
    });
    const result=run();
    if("conflict" in result)throw new Error("shadow observation identity conflict; journal held");
    if(!result.replay){
      const row=result.record;
      try{this.writeCheckpoint({sequence:row.sequence,digest:row.digest});}
      catch(error){try{this.markHold("checkpoint-write-unacknowledged",eventId);}catch{}
        throw new Error("shadow checkpoint unavailable; execution custody unresolved",{cause:error});}
    }
    return result;
  }

  /** An unresolved external effect is a startup refusal. No assumed close. */
  reconcile(retained:Array<{id:string;tier:string}>,bootId:string,hostId:string):void {
    try{this.verifyChain(hostId);}catch(error){
      try{this.hold("journal_integrity_invalid","startup");}catch{}
      throw error;
    }
    const events=this.db.prepare(`SELECT action_id,kind,payload FROM shadow_events ORDER BY sequence`)
      .all() as Array<{action_id:string;kind:ShadowKind;payload:string}>;
    const byAction=new Map<string,Array<{kind:ShadowKind;fields:string[]}>>();
    for(const event of events){
      const fields=JSON.parse(event.payload) as string[];
      const rows=byAction.get(event.action_id)??[];rows.push({kind:event.kind,fields});
      byAction.set(event.action_id,rows);
      if(event.kind==="interrupted"||event.kind==="launch-uncertain")
        this.hold(event.kind,event.action_id);
    }
    for(const [actionId,rows] of byAction){
      const intent=rows.find(x=>x.kind==="launch-intent");if(!intent)continue;
      const result=rows.find(x=>["launch-returned","launch-failed","launch-uncertain","interrupted"].includes(x.kind));
      if(result?.kind==="launch-uncertain" || result?.kind==="interrupted")this.hold(result.kind,actionId);
      if(intent.fields[7]!==bootId && result?.kind==="launch-returned")
        this.hold("prior-launch-requires-reconciliation",actionId);
      if(!result){
        // Persist the durable hold FIRST. If the following signed event fails,
        // restart still sees the hold and retries reconciliation.
        this.hold("interrupted_launch",actionId);
        try{this.append("interrupted",{hostId,supervisorBootId:bootId,sandboxId:intent.fields[8]!,
          ownerKey:intent.fields[9]!,runtimeGeneration:Number(intent.fields[10]),actionId,
          monotonicNs:process.hrtime.bigint().toString(),observedWallMs:String(Date.now())},true);}catch{}
      }
    }
    if(retained.some(row=>row.tier==="hot"||row.tier==="warm"))
      this.hold("retained_live_execution","startup");
    if(this.held())throw new Error("shadow journal has unresolved execution; refusing readiness");
  }

  fenceShutdown(bootId:string):void {
    const intents=this.db.prepare("SELECT payload FROM shadow_events WHERE kind='launch-intent'")
      .all() as Array<{payload:string}>;
    if(intents.some(row=>(JSON.parse(row.payload) as string[])[7]===bootId))
      this.markHold("supervisor-shutdown-after-execution",bootId);
  }

  recordTeardownReturned(sandboxId:string,hostId:string,bootId:string):void {
    const actions=this.db.prepare(`SELECT action_id,kind,payload FROM shadow_events
      WHERE kind IN ('launch-returned','teardown-returned') ORDER BY sequence DESC`)
      .all() as Array<{action_id:string;kind:string;payload:string}>;
    const launch=actions.find(event=>event.kind==="launch-returned" &&
      (JSON.parse(event.payload) as string[])[8]===sandboxId &&
      !actions.some(end=>end.action_id===event.action_id&&end.kind==="teardown-returned"));
    if(!launch)return;
    const fields=JSON.parse(launch.payload) as string[];
    this.append("teardown-returned",{hostId,supervisorBootId:bootId,sandboxId,
      ownerKey:fields[9]!,runtimeGeneration:Number(fields[10]),actionId:launch.action_id,
      monotonicNs:process.hrtime.bigint().toString(),observedWallMs:String(Date.now())},true);
  }

  export():{journalId:string;keyId:string;publicKey:string;held:boolean;records:ShadowRecord[]} {
    return {journalId:this.journalId,keyId:this.keyId,publicKey:this.publicKey,held:this.held(),
      records:this.db.prepare(`SELECT sequence,event_id AS eventId,action_id AS actionId,
        kind,payload,digest,signature FROM shadow_events ORDER BY sequence`).all() as ShadowRecord[]};
  }
  close():void {this.db.close();}
}
