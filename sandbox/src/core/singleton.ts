import type Database from "better-sqlite3";
import { conflict } from "../errors.js";

/** Durable, opt-in one-sandbox custody for an isolated small VM. A failed or
 * interrupted create never frees the slot implicitly: an operator must resolve
 * an orphan rather than allowing another logical pod onto the same guest. */
export class SingletonSlot {
  constructor(private readonly db: Database.Database, readonly enabled: boolean) {
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_singleton_policy (
      slot INTEGER PRIMARY KEY CHECK(slot=1), profile TEXT NOT NULL CHECK(profile='small-v1')
    );
    CREATE TABLE IF NOT EXISTS singleton_allocations (
      sandbox_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create','import')),
      operation_key TEXT UNIQUE, fingerprint TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'claimed'
        CHECK(phase IN ('claimed','retired')),
      claimed_at INTEGER NOT NULL, retired_at INTEGER,
      CHECK ((phase='retired')=(retired_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS singleton_one_active ON singleton_allocations((1)) WHERE retired_at IS NULL;
    CREATE TRIGGER IF NOT EXISTS singleton_sandbox_insert BEFORE INSERT ON sandboxes
      WHEN EXISTS(SELECT 1 FROM runtime_singleton_policy WHERE slot=1)
      BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM singleton_allocations a
          WHERE a.sandbox_id=NEW.id AND a.owner_key=NEW.owner_key AND a.retired_at IS NULL)
          OR EXISTS(SELECT 1 FROM sandboxes WHERE id<>NEW.id)
          THEN RAISE(ABORT,'singleton allocation required') END;
      END;`);
    const policy=db.prepare("SELECT profile FROM runtime_singleton_policy WHERE slot=1").get() as {profile:string}|undefined;
    if (!enabled) {
      if (policy) throw new Error("retained singleton profile cannot boot as a shared runtime");
      return;
    }
    if (policy && policy.profile!=="small-v1") throw new Error("singleton profile version mismatch");
    const rows=db.prepare("SELECT id,owner_key FROM sandboxes").all() as Array<{id:string;owner_key:string|null}>;
    const active=db.prepare("SELECT sandbox_id,owner_key FROM singleton_allocations WHERE retired_at IS NULL").all() as Array<{sandbox_id:string;owner_key:string}>;
    // Never adopt old or unexplained state by deleting/relabeling it. An empty
    // fresh template can activate; retained rows need an explicit operator cutover.
    if(rows.length>1 || active.length>1 || rows.some(r=>!r.owner_key || active.length!==1 ||
      active[0]!.sandbox_id!==r.id || active[0]!.owner_key!==r.owner_key))
      throw new Error("small profile has unowned or conflicting retained sandbox state");
    if(!policy)db.prepare("INSERT INTO runtime_singleton_policy(slot,profile) VALUES (1,'small-v1')").run();
  }

  /** May be called within the operation-ledger transaction. No await is allowed
   * between the durable claim and a competing claim's decision. */
  claim(id:string,owner:string,kind:"create"|"import",fingerprint:string,key:string|null):void {
    if(!this.enabled)return;
    const existing=this.db.prepare("SELECT sandbox_id,owner_key,kind,fingerprint,operation_key FROM singleton_allocations WHERE retired_at IS NULL")
      .get() as {sandbox_id:string;owner_key:string;kind:string;fingerprint:string;operation_key:string|null}|undefined;
    if(existing){
      if(existing.sandbox_id===id && existing.owner_key===owner && existing.kind===kind &&
        existing.fingerprint===fingerprint && existing.operation_key===key)return;
      throw conflict("small VM already belongs to another sandbox or request", "retain and reconcile the original allocation");
    }
    if(this.db.prepare("SELECT 1 FROM singleton_allocations WHERE sandbox_id=?").get(id))
      throw conflict("retired sandbox identity cannot be reused");
    this.db.prepare(`INSERT INTO singleton_allocations(sandbox_id,owner_key,kind,operation_key,fingerprint,claimed_at)
      VALUES (?,?,?,?,?,?)`).run(id,owner,kind,key,fingerprint,Date.now());
  }

  hasActiveId(id:string):boolean {
    return this.enabled && Boolean(this.db.prepare("SELECT 1 FROM singleton_allocations WHERE sandbox_id=? AND retired_at IS NULL").get(id));
  }

  assert(id:string,owner:string|null):void {
    if(!this.enabled)return;
    const row=this.db.prepare("SELECT owner_key FROM singleton_allocations WHERE sandbox_id=? AND retired_at IS NULL")
      .get(id) as {owner_key:string}|undefined;
    if(!owner || !row || row.owner_key!==owner)throw conflict("small VM sandbox allocation is not owned");
  }

  /** Caller has already verified teardown and no admission quarantine. Only a
   * user-visible explicit deletion can free the live slot; history is retained. */
  retire(id:string,owner:string):void {
    if(!this.enabled)return;
    this.assert(id,owner);
    const run=this.db.transaction(()=>{
      if(this.db.prepare("SELECT 1 FROM sandboxes WHERE id=?").get(id))throw new Error("sandbox row still retained");
      this.db.prepare("UPDATE singleton_allocations SET phase='retired',retired_at=? WHERE sandbox_id=? AND owner_key=? AND retired_at IS NULL")
        .run(Date.now(),id,owner);
    });
    run();
  }
}
