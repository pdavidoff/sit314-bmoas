'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const f = require('../infra/foundation.json'), s = require('../infra/services.json');
test('each queue has a TLS policy with exactly one matching queue resource', () => {
    const queues = Object.entries(f.Resources).filter(([, r]) => r.Type === 'AWS::SQS::Queue').map(([name]) => name);
    const covered = new Set();
    for (const r of Object.values(f.Resources).filter(r => r.Type === 'AWS::SQS::QueuePolicy')) {
        assert.equal(r.Properties.Queues.length, 1);
        const name = r.Properties.Queues[0].Ref;
        const statements = r.Properties.PolicyDocument.Statement;
        assert.ok(statements.some(statement => {
            assert.ok(!Array.isArray(statement.Resource), 'SQS rejects multiple resources in a statement');
            return statement.Effect === 'Deny' && statement.Action === 'sqs:*'
                && statement.Condition?.Bool?.['aws:SecureTransport'] === 'false'
                && JSON.stringify(statement.Resource) === JSON.stringify({ 'Fn::GetAtt': [name, 'Arn'] });
        }));
        covered.add(name);
    }
    assert.deepEqual([...covered].sort(), queues.sort());
});
test('approved scaling range and CPU policy are preserved', () => { const t = s.Resources.AggregationTarget.Properties, p = s.Resources.CpuPolicy.Properties.TargetTrackingScalingPolicyConfiguration; assert.equal(s.Parameters[t.MinCapacity.Ref].Default, 1); assert.equal(s.Parameters[t.MinCapacity.Ref].MaxValue, 4); assert.equal(t.MaxCapacity, 4); assert.equal(p.TargetValue, 60); assert.equal(p.ScaleOutCooldown, 60); assert.equal(p.ScaleInCooldown, 180); assert.equal(p.PredefinedMetricSpecification.PredefinedMetricType, 'ECSServiceAverageCPUUtilization'); });
test('ECS services have no public IP', () => { for (const r of Object.values(s.Resources))
    if (r.Type === 'AWS::ECS::Service')
        assert.equal(r.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp, 'DISABLED'); });
test('every queue uses encryption and processing queues have dead-letter policies', () => { for (const r of Object.values(f.Resources))
    if (r.Type === 'AWS::SQS::Queue')
        assert.equal(r.Properties.SqsManagedSseEnabled, true); for (const n of ['Raw', 'Checked', 'Aggregate'])
    assert.equal(f.Resources[n + 'Queue'].Properties.RedrivePolicy.maxReceiveCount, 5); });
test('no inbound network rule exposes the application or Node-RED', () => assert.equal(f.Resources.ServiceSecurityGroup.Properties.SecurityGroupIngress, undefined));
test('IoT rule preserves bytes and uses the standard queue action', () => { const p = f.Resources.IngressRule.Properties.TopicRulePayload; assert.match(p.Sql['Fn::Sub'], /encode\(\*, 'base64'\)/); assert.match(p.Sql['Fn::Sub'], /topic\(3\)/); assert.ok(p.Actions[0].Sqs); });
test('cloud database secrets are injected rather than embedded as literals', () => { for (const n of ['Validator', 'Aggregator', 'Reporter']) {
    const c = s.Resources[n + 'Task'].Properties.ContainerDefinitions[0];
    assert.ok(c.Secrets.some(x => x.Name === 'MONGODB_URI'));
    assert.ok(!c.Environment.some(x => x.Name === 'MONGODB_URI'));
} });
