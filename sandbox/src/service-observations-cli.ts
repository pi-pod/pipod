#!/usr/bin/env node
/** Read-only export of nonbillable shadow lifecycle observations. Operator only. */
import path from "node:path";
import Database from "better-sqlite3";
import { ShadowObservationJournal } from "./core/service-observation-journal.js";

function main(){
  const i=process.argv.indexOf("--state-dir");
  const state=i>=0?process.argv[i+1]:null;
  const mode=process.argv.includes("--export")?"export":process.argv.includes("--status")?"status":null;
  if(!state || !path.isAbsolute(state) || !mode ||
    (process.argv.includes("--export") && process.argv.includes("--status")))
    throw new Error("explicit state dir and one read-only mode required");
  const db=new Database(path.join(state,ShadowObservationJournal.filename),
    {readonly:true,fileMustExist:true});
  try{
    db.pragma("query_only = ON");
    const snapshot=db.transaction(()=>{
      const meta=db.prepare("SELECT journal_id AS journalId,key_id AS keyId,public_key AS publicKey FROM shadow_meta LIMIT 1")
        .get() as {journalId:string;keyId:string;publicKey:string}|undefined;
      if(!meta)throw new Error("shadow metadata unavailable");
      const held=Boolean(db.prepare("SELECT 1 FROM shadow_holds LIMIT 1").get());
      const count=(db.prepare("SELECT count(*) AS n FROM shadow_events").get() as {n:number}).n;
      if(count>1000)throw new Error("shadow journal bound exceeded");
      if(mode==="status")return {status:"UNVERIFIED_LOCAL_STATUS",localHoldPresent:held,
        journalId:meta.journalId,keyId:meta.keyId,events:count};
      const records=db.prepare(`SELECT sequence,event_id AS eventId,action_id AS actionId,
        kind,payload,digest,signature FROM shadow_events ORDER BY sequence LIMIT 1001`).all();
      if(records.length!==count)throw new Error("shadow export incomplete");
      return {...meta,held,records};
    })();
    console.log(JSON.stringify(snapshot));
  }finally{db.close()}
}
try{main()}catch(error){console.error(`shadow export unavailable: ${error instanceof Error?error.name:"error"}`);process.exitCode=1}
