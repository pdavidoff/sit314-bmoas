'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const template = require('../infra/services.json');

test('audience timetable retains recovery capacity when lowering the overnight floor', () => {
    for (const name of ['NodeRedTarget', 'ValidatorTarget', 'AggregationTarget']) {
        const conditional = template.Resources[name].Properties.ScheduledActions['Fn::If'];
        assert.equal(conditional[0], 'AudienceSchedule');
        const actions = conditional[1];
        const overnight = actions.find(action => action.ScheduledActionName === 'audience-overnight');
        assert.equal(overnight.ScalableTargetAction.MinCapacity, 1);
        assert.equal(overnight.ScalableTargetAction.MaxCapacity, 4);
        for (const action of actions) {
            assert.ok(action.ScalableTargetAction.MinCapacity >= 1);
            assert.ok(action.ScalableTargetAction.MinCapacity <= action.ScalableTargetAction.MaxCapacity);
            assert.equal(action.ScalableTargetAction.MaxCapacity, 4);
            assert.deepEqual(action.Timezone, { Ref: 'CapacityTimezone' });
        }
    }
    assert.equal(template.Parameters.ScheduledCapacity.Default, 'false');
});
