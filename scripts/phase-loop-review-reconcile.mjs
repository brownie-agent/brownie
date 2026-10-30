#!/usr/bin/env node
/**
 * Turn GitHub review facts into an append-only claim update.  This is kept
 * separate from process execution so an open PR can never be mistaken for a
 * finished TODO.
 */
import fs from 'node:fs';
import path from 'node:path';

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function login(value) {
  return typeof object(value).login === 'string' ? object(value).login : '';
}

function allChecksPassed(pullRequest) {
  const checks = list(object(pullRequest).statusCheckRollup);
  return checks.length > 0 && checks.every((check) => (
    object(check).status === 'COMPLETED' && object(check).conclusion === 'SUCCESS'
  ));
}

function reviewAtHead(review, headOid) {
  const commitOid = object(object(review).commit).oid;
  return !headOid || !commitOid || commitOid === headOid;
}

export function reconcileReviewSnapshot({ claim, pullRequest, reviewer, implementation }) {
  const before = object(claim);
  const pr = object(pullRequest);
  const rootClaimId = before.root_claim_id ?? before.claim_id ?? null;
  const headOid = typeof pr.headRefOid === 'string' ? pr.headRefOid : '';
  const reviews = list(pr.reviews);
  const reviewActor = String(reviewer ?? '');
  const implementationActor = String(implementation ?? '');
  const errors = [];
  if (!rootClaimId || !before.selected_todo) errors.push('claim_identity_missing');
  if (!reviewActor || !implementationActor) errors.push('configured_actor_missing');
  if (login(pr.author) !== implementationActor) errors.push('implementation_author_mismatch');
  if (reviewActor === implementationActor) errors.push('reviewer_not_independent');
  const ownReviews = reviews.filter((review) => login(review.author) === reviewActor && reviewAtHead(review, headOid));
  const requested = ownReviews.some((review) => object(review).state === 'CHANGES_REQUESTED');
  const approved = ownReviews.some((review) => object(review).state === 'APPROVED');
  const ciPassed = allChecksPassed(pr);
  const merged = pr.state === 'MERGED' && typeof pr.mergedAt === 'string';
  let status = 'pr_pending_review';
  if (requested) status = 'changes_requested';
  else if (merged && approved && ciPassed && errors.length === 0) status = 'completed';
  else if (pr.state === 'CLOSED') status = 'integrity_blocked';
  const feedback = ownReviews
    .filter((review) => object(review).state === 'CHANGES_REQUESTED')
    .map((review) => ({ submitted_at: object(review).submittedAt ?? null, body: object(review).body ?? '' }));
  return {
    valid: errors.length === 0,
    errors,
    status,
    delivery_review: {
      pr_url: typeof pr.url === 'string' ? pr.url : null,
      pr_number: Number.isInteger(pr.number) ? pr.number : null,
      author: login(pr.author) || null,
      reviewer: reviewActor || null,
      head_oid: headOid || null,
      merged,
      approved,
      ci_passed: ciPassed,
      review_decision: pr.reviewDecision ?? null,
      observed_at: new Date().toISOString()
    },
    feedback
  };
}

export function applyReviewReconciliation({ claim, reconciliation, at = new Date().toISOString(), runStamp = '' }) {
  const before = object(claim);
  const result = object(reconciliation);
  const next = structuredClone(before);
  next.root_claim_id ??= next.claim_id;
  next.delivery_review = result.delivery_review;
  next.status = result.status;
  next.updated_at = at;
  next.run_stamp = runStamp;
  next.status_history = list(next.status_history);
  next.status_history.push({
    status: result.status,
    run_stamp: runStamp,
    updated_at: at,
    note: 'github_review_reconciled'
  });
  if (result.status === 'changes_requested') {
    next.failure_history = list(next.failure_history);
    next.failure_history.push({
      at,
      run_stamp: runStamp,
      status: 'changes_requested',
      root_claim_id: next.root_claim_id,
      reason: 'independent_review_requested_changes',
      feedback: result.feedback
    });
    next.review_rework = {
      required: true,
      root_claim_id: next.root_claim_id,
      pr_url: result.delivery_review?.pr_url ?? null,
      feedback: result.feedback,
      observed_at: at
    };
  } else if (result.status === 'completed') {
    next.review_rework = { required: false, resolved_at: at };
  }
  return next;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) values.set(argv[index], argv[index + 1]);
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(3));
  if (command !== 'reconcile' || !args.get('--claim') || !args.get('--review') || !args.get('--reviewer') || !args.get('--implementation')) {
    process.stderr.write('usage: phase-loop-review-reconcile.mjs reconcile --claim <claim.json> --review <pr.json> --reviewer <login> --implementation <login> [--write] [--run <stamp>]\n');
    process.exit(64);
  }
  try {
    const claimPath = args.get('--claim');
    const reconciliation = reconcileReviewSnapshot({
      claim: readJson(claimPath),
      pullRequest: readJson(args.get('--review')),
      reviewer: args.get('--reviewer'),
      implementation: args.get('--implementation')
    });
    const next = applyReviewReconciliation({
      claim: readJson(claimPath),
      reconciliation,
      runStamp: args.get('--run') ?? ''
    });
    if (args.has('--write')) {
      const target = path.resolve(claimPath);
      const temporary = `${target}.${process.pid}.review-reconcile.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
    }
    process.stdout.write(`${JSON.stringify({ reconciliation, claim: next })}\n`);
    process.exit(reconciliation.valid ? 0 : 76);
  } catch (error) {
    process.stderr.write(`review_reconciliation_failed: ${error.message}\n`);
    process.exit(70);
  }
}
