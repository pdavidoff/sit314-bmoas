'use strict';
const { BatchWriter } = require('./batch');
class SqsQueue {
    constructor(options = {}) {
        const s = require('@aws-sdk/client-sqs');
        this.sdk = s;
        const endpoint = options.endpoint ?? process.env.SQS_ENDPOINT;
        this.client = options.client || new s.SQSClient({ region: process.env.AWS_REGION || 'ap-southeast-2', ...(endpoint ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}), maxAttempts: 4 });
        this.urls = options.urls || Object.fromEntries(['raw', 'checked', 'aggregate', 'rejected'].map(n => [n, process.env[`QUEUE_${n.toUpperCase()}_URL`]]));
        this.batching = options.batching ?? process.env.QUEUE_BATCHING !== 'false';
        this.sends = new BatchWriter((name, Entries) => this.client.send(new s.SendMessageBatchCommand({ QueueUrl: this.url(name), Entries })));
        this.deletes = new BatchWriter((name, Entries) => this.client.send(new s.DeleteMessageBatchCommand({ QueueUrl: this.url(name), Entries })));
    }
    url(name) { const u = this.urls[name]; if (!u)
        throw new Error(`Missing queue URL: ${name}`); return u; }
    async send(name, body) {
        if (this.batching) return this.sends.enqueue(name, { MessageBody: JSON.stringify(body) });
        await this.client.send(new this.sdk.SendMessageCommand({ QueueUrl: this.url(name), MessageBody: JSON.stringify(body) })); }
    async receive(name, { max = 10, visibility = 60, wait = 2 } = {}) {
        const r = await this.client.send(new this.sdk.ReceiveMessageCommand({ QueueUrl: this.url(name), MaxNumberOfMessages: max, VisibilityTimeout: visibility, WaitTimeSeconds: wait, MessageSystemAttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'] }));
        return (r.Messages || []).map(m => ({ id: m.MessageId, receipt: m.ReceiptHandle, body: m.Body, enqueuedAt: Number(m.Attributes?.SentTimestamp), attempt: Number(m.Attributes?.ApproximateReceiveCount || 1) }));
    }
    async remove(name, receipt) {
        if (this.batching) return this.deletes.enqueue(name, { ReceiptHandle: receipt });
        await this.client.send(new this.sdk.DeleteMessageCommand({ QueueUrl: this.url(name), ReceiptHandle: receipt })); }
    async extend(name, receipt, seconds) { await this.client.send(new this.sdk.ChangeMessageVisibilityCommand({ QueueUrl: this.url(name), ReceiptHandle: receipt, VisibilityTimeout: seconds })); }
    async stats(name) { const r = await this.client.send(new this.sdk.GetQueueAttributesCommand({ QueueUrl: this.url(name), AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] })); return { visible: Number(r.Attributes?.ApproximateNumberOfMessages || 0), in_flight: Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible || 0) }; }
    async close() { await Promise.all([this.sends.close(), this.deletes.close()]); this.client.destroy(); }
}
let override;
function getQueue() { return override || new SqsQueue(); }
function setQueue(q) { override = q; }
module.exports = { SqsQueue, getQueue, setQueue };
