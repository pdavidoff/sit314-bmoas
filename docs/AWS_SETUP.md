# AWS setup — execute in your account

No AWS or Atlas resource has been created by this package. These steps are deliberately staged so that permissions, cost and integration problems are found before the high-load experiment.

## 1. Confirm the environment

Use an AWS account with permission to create project-specific IAM roles, VPC/NAT resources, SQS, IoT rules, ECR, ECS, CloudWatch and Secrets Manager. A restricted learner lab may deny some of these. Do not bypass its restrictions or substitute broad administrator access without approval. AWS CLI v2, Docker and Python 3 are required for the supplied setup scripts. Authenticate with your normal local SSO/credential mechanism; never paste credentials into chat.

Copy `config/cloud.env.example` to `config/cloud.env`. Set your region and stack names. Sydney is only the default. Run:

```sh
bash scripts/aws-setup.sh preflight
```

This reports the AWS account and validates template syntax through AWS. It does not prove that deployment permissions or service quotas are sufficient.

## 2. Create the foundation

Review `infra/foundation.json`. It creates a VPC, two private subnets, one NAT gateway, a fixed egress address, ECS cluster, ECR repository, processing/quarantine/dead-letter queues and an IoT rule. NAT, public IPv4, compute, queues, logs and Atlas can incur charges. Create a budget alert, but do not treat a budget alert as an automatic spending cap.

```sh
CONFIRM_ACCOUNT=YOUR_ACCOUNT_NUMBER bash scripts/aws-setup.sh foundation
```

Record the `EgressIp`, queue URLs, cluster name and ECR URI from outputs. There are no public application ports. Two private subnets do not make the single NAT gateway highly available.

## 3. Configure MongoDB Atlas on AWS

Use an existing suitable Atlas deployment or create one on AWS in the selected region after reviewing capacity and cost. The Free tier is suitable only for small functional tests here; it is limited to 100 operations/s and each observation requires several operations.

Create a writer restricted to `readWrite` on database `bmoas` and a reader restricted to `read` on `bmoas`, preferably restricted to the selected cluster. Add the NAT address as `/32` to Atlas network access. Add your own current public address as another `/32` only for development/initialisation. Do not open Atlas to `0.0.0.0/0`. Atlas database users are distinct from users who sign into the Atlas website.

Put the writer's `mongodb+srv://...` URI in your **local ignored `.env`**, using URL-encoded credentials as needed. Set `MONGODB_DATABASE=bmoas`, `DEVICE_COUNT=10000`, `GATEWAY_COUNT=20`. Run `npm run init` before starting cloud services. This creates the indexes and synthetic registry. Then use the reader URI for collection/reporting where possible. Never reuse the local unauthenticated URI for AWS.

Sources: [Atlas database users](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/), [Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/).

## 4. Store secrets

Use dedicated AWS Secrets Manager values containing the raw URI/token, not JSON objects. The helper prompts without echo and uses a temporary private file rather than putting a secret on the command line:

```sh
python3 scripts/put-secret.py --name bmoas/mongo-writer --confirm-account YOUR_ACCOUNT_NUMBER
python3 scripts/put-secret.py --name bmoas/mongo-reader --confirm-account YOUR_ACCOUNT_NUMBER
python3 scripts/put-secret.py --name bmoas/api-token --generate-token --confirm-account YOUR_ACCOUNT_NUMBER
```

Add `--region YOUR_REGION` when not using Sydney. Record only the resulting ARNs in `config/cloud.env`. Existing secrets are not overwritten automatically. ECS injects secrets at task start; rotating a secret requires a new deployment of the consuming tasks.

## 5. Build and deploy

Generate/review/commit `package-lock.json` locally first. Run unit and MongoDB integration tests. Then:

```sh
CONFIRM_ACCOUNT=YOUR_ACCOUNT_NUMBER bash scripts/aws-setup.sh image
```

Copy the printed `IMAGE_URI` into `config/cloud.env`. Set the three secret ARNs, then:

```sh
CONFIRM_ACCOUNT=YOUR_ACCOUNT_NUMBER bash scripts/aws-setup.sh services
```

The service stack starts Node-RED, validation, aggregation and reporting. It configures the accepted aggregation policy: 1–4 tasks, average CPU 60%, cooldowns 60 seconds out / 180 seconds in. These values are configuration, not evidence that scaling happened. Target tracking manages its own CloudWatch alarms; do not manually edit those generated alarms.

Source: [ECS target tracking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-targettracking.html).

## 6. Provision and test MQTT gateways

```sh
python3 scripts/provision-gateways.py --count 20 --confirm-account YOUR_ACCOUNT_NUMBER
```

Use `--region` as appropriate. The helper creates synthetic IoT Things, one certificate per gateway and a policy allowing only that gateway's client ID and publication topic. Keys remain under ignored `secrets/`. Record the printed MQTT endpoint; set `MQTT_URL=mqtts://YOUR_ENDPOINT:8883` and `GATEWAY_CONFIG=config/gateways.json` in `.env`. Leave `DEVICE_COUNT=10000` and `GATEWAY_COUNT=20` consistent with the seeded registry. The smoke profile uses only the first 10 logical devices.

Stop all local processing services and the local bridge. Set `SQS_ENDPOINT=` and the four real queue URLs in `.env`; keep the Atlas reader URI for collection. Do not run local and cloud consumers against the same queues accidentally. Run only the simulator and, in another terminal, the evidence collector:

```sh
npm run collect -- --run aws-smoke-001 --seconds 180 --aws --cluster YOUR_CLUSTER --service YOUR_AGGREGATION_SERVICE
npm run simulate -- --profile smoke --run aws-smoke-001
```

Confirm messages traverse the IoT rule, all three queues, Node-RED, validation, Atlas and aggregation. Inspect the rule failure queue and dead-letter queues as well as ordinary queues. A broker PUBACK alone is not proof that the IoT rule delivered into SQS.

## 7. Inspect private reporting

Find the reporter task in ECS and use **ECS Exec**, with the required local Session Manager plugin and permissions:

```sh
aws ecs execute-command --cluster YOUR_CLUSTER --task REPORTER_TASK_ARN \
  --container reporter --interactive \
  --command 'node scripts/query.js /v1/reports?run_id=aws-smoke-001'
```

The helper reads its token inside the task and does not print it. The reporting API is intentionally private. A public HTTPS dashboard is not part of this first release. Production Node-RED disables its editor; edit/export flows locally and deploy a reviewed image.

## 8. CI/CD

The CI workflow checks syntax, unit tests, MongoDB transactions and Docker build. The manual deployment workflow requires a protected GitHub environment named `bmoas-aws`, a project-scoped AWS deployment role and GitHub OIDC trust. Configure these deliberately; no AWS administrator role or long-lived GitHub AWS key is supplied.

Set the repository/environment variables named in `.github/workflows/deploy.yml`. Restrict the OIDC trust to the exact repository/environment, and protect which branch may deploy. Record a successful run and a controlled change only after executing the workflow. Workflow files alone are not CI/CD evidence.

## 9. Teardown

Export evidence before deletion. Delete the services stack first, wait for completion, then delete the foundation stack. This removes the NAT gateway and running services. The ECR repository is deliberately retained, and separately provisioned IoT Things/certificates/policies, Secrets Manager values and Atlas are not deleted by CloudFormation. Revoke and remove those deliberately, remove Atlas IP entries no longer required and verify billing/remaining resources. Queues in the foundation are deleted with their contents.

Do not leave a NAT gateway or paid Atlas cluster running merely because ECS tasks have been stopped.

## Project namespace

Use the same project name in the foundation template, gateway certificate policies and simulator topic prefix. `scripts/provision-gateways.py --project bmoas --confirm-account YOUR_ACCOUNT_ID` prepares the gateway configuration for the default project. If a different project is used, set `MQTT_TOPIC_PREFIX` to that name in the simulator environment. Private gateway files are created under `secrets/` and excluded from Git.
