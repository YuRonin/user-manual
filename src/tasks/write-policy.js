'use strict';
const {isProduction, originMatches}=require('../scenarios/policy');

// Authorization is part of the task approval scope. It applies only to listed
// steps at the registered test origin, until expiry; it never enables deletion.
function permitsWrite(task, step, config, now=Date.now()) {
  const grant=task.writeAuthorization;
  if (!grant || !config || !grant.steps?.includes(step.id)) return false;
  const env=config.fixtures?.environments?.[task.environment];
  if (!env || isProduction(task.environment,env)) return false;
  const origin=new URL(config.project.baseUrl).origin;
  return grant.origin===origin && env.origins?.some(p=>originMatches(p,origin)) &&
    typeof grant.decisionRef==='string' && grant.decisionRef.trim().length>0 &&
    Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt)>now;
}
module.exports={permitsWrite};
