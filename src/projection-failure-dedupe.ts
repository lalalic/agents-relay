/** Report terminal projection faults once per Job version and reason while still retrying delivery. */
export class ProjectionFailureDeduplicator {
  private readonly seen = new Map<string, string>();

  shouldReport(jobId: string, updatedAt: string, reason: string, classification: string): boolean {
    if (classification !== 'terminal') {
      this.seen.delete(jobId);
      return true;
    }
    const signature = `${updatedAt}\0${reason}`;
    if (this.seen.get(jobId) === signature) return false;
    this.seen.delete(jobId);
    this.seen.set(jobId, signature);
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }
}
