# Capacity management for expected audience demand

BMOAS collects observations used to calculate audience ratings. News programmes, sporting events and historical ratings schedules can identify periods when greater ingestion capacity may be needed. Actual meter publication frequency must also be considered: a larger audience does not automatically increase message frequency for a fixed fleet of continuously reporting meters.

The conventional design combines scheduled capacity with reactive CPU and queue scaling across Node-RED, validation and aggregation. Scheduling creates capacity before the expected demand. Reactive scaling responds to deviations from that forecast. The maximum remains four tasks per processing stage.

The optional CloudFormation timetable uses Australia/Sydney time, including daylight saving. Its illustrative schedule raises the minimum to four at 05:45 and 17:45, fifteen minutes before assumed 06:00 and 18:00 events. It lowers the minimum to two at 10:00 and one at 23:00. These times are assumptions, not measured audience forecasts. Programme schedules and historical observations should determine operational settings. Additional sporting events can use a one-off scheduled action. All times are parameters and ScheduledCapacity defaults to false.

Reducing the minimum permits the existing scaling policies to reduce capacity as demand falls. It does not immediately force tasks to stop. The maximum remains four overnight so delayed observations and unexpected events can still be processed. Operational monitoring must confirm that the backlog clears. A minimum of four uses the entire approved task range, so reactive scaling has no further headroom during those periods.

Before a planned peak, verify that the required number of tasks are running and healthy. Measure the time from the scheduled action to healthy capacity and set the lead time accordingly. Evaluate whole-path p95 latency, accepted throughput, backlog recovery, observation identifiers and exact ratings. A successful scheduled action alone does not establish the timing targets.

The temporary evaluation starts with four tasks per processing stage, then tests the original baseline, sustained load and reconnect profiles. Results must label this provisioned capacity separately from the earlier reactive trials. Recurring schedules are kept disabled during these controlled tests to avoid changing capacity unexpectedly. A separate bounded one-off schedule can demonstrate the preparation mechanism and its startup time within the same approved window.

AWS documentation: https://docs.aws.amazon.com/autoscaling/application/userguide/scheduled-scaling-policy-overview.html
AWS CloudFormation scheduled actions: https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-applicationautoscaling-scalabletarget-scheduledaction.html
