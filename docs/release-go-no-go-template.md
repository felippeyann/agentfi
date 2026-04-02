# Release Go/No-Go Template

Copy this block into a PR comment, release issue, or deployment ticket before production dispatch.

```markdown
## Release Go/No-Go — AgentFi

### Release Metadata
- Ref (tag/SHA):
- Environment: production
- Deployer:
- Date (UTC):

### Pre-Dispatch Gates
- [ ] CI green on release ref (`ci.yml`)
- [ ] `npm run preflight` passed
- [ ] `npm run preflight:deploy-scenarios` passed
- [ ] Required Railway secrets present (`RAILWAY_*`)
- [ ] Worker service variable reviewed (`RAILWAY_PRODUCTION_WORKER_SERVICE`)

### Security and Access Gates
- [ ] Admin auth config set (`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `NEXTAUTH_SECRET`)
- [ ] Admin lockout config set (`ADMIN_AUTH_*`)
- [ ] No active unresolved critical security incidents

### Deployment Decision
- [ ] GO
- [ ] NO-GO
- Reason:

### Post-Deploy Verification (fill after deploy)
- [ ] `/health` OK
- [ ] `/health/ready` OK
- [ ] Worker deployment verified (if configured)
- [ ] No sustained 5xx spike (first 10–15 min)
- [ ] No Redis quota/queue anomalies

### Rollback Trigger Conditions
- [ ] Critical readiness check failed
- [ ] Sustained high error rate
- [ ] Queue backlog growth out of bounds
- [ ] Security/auth anomaly threshold breached
```
