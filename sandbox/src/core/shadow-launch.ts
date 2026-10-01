import { randomUUID } from "node:crypto";
import { ShadowUncertainExecution, type ShadowIdentity, type ShadowObservationJournal } from "./service-observation-journal.js";

/** The only instrumented external launch boundary. A rejected detached-start
 * call is unknown, never proof the workload was not created. */
export async function launchWithShadowObservation<T>(journal:ShadowObservationJournal,
  identity:(actionId:string)=>ShadowIdentity,perform:()=>Promise<T>):Promise<T>{
  const actionId=randomUUID();
  const base=identity(actionId);
  try{journal.append("launch-intent",base);}
  catch(error){
    try{journal.markHold("launch-intent-unacknowledged",base.actionId);}catch{}
    throw new ShadowUncertainExecution();
  }
  let value:T;
  try{value=await perform();}
  catch{
    // Set the in-process and durable fence before best-effort signed detail.
    try{journal.markHold("launch-invocation-uncertain",base.actionId);}catch{}
    try{journal.append("launch-uncertain",identity(actionId),true);}catch{}
    throw new ShadowUncertainExecution();
  }
  try{journal.append("launch-returned",identity(actionId));}
  catch{
    try{journal.markHold("launch-return-unacknowledged",base.actionId);}catch{}
    throw new ShadowUncertainExecution();
  }
  return value;
}
