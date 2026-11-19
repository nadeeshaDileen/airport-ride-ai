// Tool descriptions for the Converse API (used by steps 03 and 06).
// The model reads the name, description, and JSON schema to decide when to call a
// tool and what arguments to send. Your code runs the tool and returns the result.

import type { Tool } from '@aws-sdk/client-bedrock-runtime';
import { estimateFare, getFlightStatus, VEHICLE_TYPES, type FareInput } from './taxi-tools.js';

export const TAXI_TOOLS: Tool[] = [
  {
    toolSpec: {
      name: 'estimate_fare',
      description:
        'Estimate the fare in LKR for an airport transfer from Bandaranaike International Airport (CMB). ' +
        'Needs a vehicle type and either a destination name or a distance in km.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            vehicleType: { type: 'string', enum: [...VEHICLE_TYPES], description: 'mini, sedan or van' },
            destination: { type: 'string', description: 'Destination town, e.g. "Kandy" or "Galle"' },
            distanceKm: { type: 'number', description: 'Road distance in km, if the destination is not known' },
            pickupHour: { type: 'integer', description: 'Pickup hour in local time, 0-23 (night surcharge applies 22-5)' },
          },
          required: ['vehicleType'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_flight_status',
      description: 'Look up the live arrival status of a flight landing at CMB, e.g. "FA101".',
      inputSchema: {
        json: {
          type: 'object',
          properties: { flightNumber: { type: 'string', description: 'Flight number, e.g. "FA 245"' } },
          required: ['flightNumber'],
        },
      },
    },
  },
];

// Run a taxi tool by name. Returns an object the model can read as JSON.
export function runTaxiTool(name: string, input: unknown): Record<string, unknown> {
  switch (name) {
    case 'estimate_fare':
      return estimateFare(input as FareInput);
    case 'get_flight_status':
      return getFlightStatus(input as { flightNumber: string });
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
