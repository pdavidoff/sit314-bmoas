# Sources used for implementation checks

The project/tutor requirements in the conversation set the problem, mandatory technologies and numerical targets. The following are external implementation references, not journal research evidence for High Distinction:

- AWS IoT Core MQTT behaviour and shared subscriptions: https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html
- AWS IoT Core per-connection and queue quotas: https://docs.aws.amazon.com/general/latest/gr/iot-core.html
- IoT rule action for SQS (standard, not FIFO): https://docs.aws.amazon.com/iot/latest/developerguide/sqs-rule-action.html
- Preserving MQTT bytes with base64 in an IoT rule: https://docs.aws.amazon.com/iot/latest/developerguide/binary-payloads.html
- ECS target tracking: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-targettracking.html
- MongoDB Node.js transactions: https://www.mongodb.com/docs/drivers/node/current/crud/transactions/
- Atlas Free limits: https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/
- Atlas database users: https://www.mongodb.com/docs/atlas/security-add-mongodb-users/
- Embedding Node-RED: https://nodered.org/docs/user-guide/runtime/embedding

Review the current service quotas and documentation in the deployment account before testing. Platform documentation is not a substitute for the later peer-reviewed literature review.
