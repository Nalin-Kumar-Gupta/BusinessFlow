#!/usr/bin/env node
import { Paddle, Environment } from '@paddle/paddle-node-sdk';

const required = ['PADDLE_API_KEY', 'PADDLE_WEBHOOK_DESTINATION_URL'];
for (const key of required) {
  if (!process.env[key] || process.env[key].trim().length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
}

const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: Environment.sandbox,
});

const destination = process.env.PADDLE_WEBHOOK_DESTINATION_URL;
const description = process.env.PADDLE_WEBHOOK_DESCRIPTION || 'BusinessFlow Sandbox Billing Webhook';

const subscribedEvents = [
  'subscription.created',
  'subscription.updated',
  'subscription.canceled',
  'customer.created',
  'customer.updated',
  'transaction.completed',
  'transaction.payment_failed',
];

const existing = await paddle.notificationSettings.list();
const match = existing.find((entry) => entry.type === 'url' && entry.destination === destination);

if (!match) {
  const created = await paddle.notificationSettings.create({
    description,
    destination,
    subscribedEvents,
    type: 'url',
  });

  console.log('Created sandbox notification destination:');
  console.log(JSON.stringify({
    id: created.id,
    destination: created.destination,
    endpointSecretKey: created.endpointSecretKey,
  }, null, 2));
  process.exit(0);
}

const existingEventNames = new Set(match.subscribedEvents.map((eventType) => eventType.name));
const mergedEvents = [...new Set([...existingEventNames, ...subscribedEvents])];

const updated = await paddle.notificationSettings.update(match.id, {
  description: match.description,
  destination: match.destination,
  subscribedEvents: mergedEvents,
  type: 'url',
  includeSensitiveFields: match.includeSensitiveFields,
  trafficSource: match.trafficSource,
});

console.log('Using existing sandbox notification destination:');
console.log(JSON.stringify({
  id: updated.id,
  destination: updated.destination,
  endpointSecretKey: updated.endpointSecretKey,
}, null, 2));
