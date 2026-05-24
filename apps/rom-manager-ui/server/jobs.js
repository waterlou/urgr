const jobs = new Map();

export function createJob(id) {
  const job = { id, status: 'running', progress: { pct: 0, msg: '' }, result: null, error: null, child: null, subscribers: new Set(), createdAt: Date.now() };
  jobs.set(id, job);
  return job;
}

export function getJob(id) { return jobs.get(id); }

export function updateProgress(id, pct, msg) {
  const job = jobs.get(id);
  if (!job) return;
  job.progress = { pct, msg };
  broadcast(job, `data: ${JSON.stringify({ type: 'progress', pct, msg })}\n\n`);
}

export function doneJob(id, result) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'done';
  job.result = result;
  broadcast(job, `data: ${JSON.stringify({ type: 'result', data: result })}\n\n`);
  closeSubs(job);
}

export function failJob(id, error) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'failed';
  job.error = error;
  broadcast(job, `data: ${JSON.stringify({ type: 'error', error })}\n\n`);
  closeSubs(job);
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.status = 'cancelled';
  if (job._abort) { job._abort.abort(); }
  if (job.child) job.child.kill('SIGTERM');
  broadcast(job, `data: ${JSON.stringify({ type: 'cancelled' })}\n\n`);
  closeSubs(job);
  return true;
}

function broadcast(job, msg) {
  for (const sub of job.subscribers) {
    sub.write(msg);
  }
}

function closeSubs(job) {
  for (const sub of job.subscribers) sub.end();
  job.subscribers.clear();
}
