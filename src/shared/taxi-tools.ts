// Mock business logic for Palmway Transfers, a fictional airport transfer company.
// In a real app these functions would call your pricing service and a flight data API.
// Here they use small in-memory tables so the demo runs anywhere and costs nothing.

export const VEHICLE_TYPES = ['mini', 'sedan', 'van'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

interface Vehicle {
  label: string;
  maxPassengers: number;
  maxSuitcases: number;
  baseFareLkr: number;
  perKmLkr: number;
}

const VEHICLES: Record<VehicleType, Vehicle> = {
  mini: { label: 'Mini car', maxPassengers: 3, maxSuitcases: 2, baseFareLkr: 1500, perKmLkr: 110 },
  sedan: { label: 'Sedan', maxPassengers: 3, maxSuitcases: 3, baseFareLkr: 2000, perKmLkr: 130 },
  van: { label: 'Van', maxPassengers: 8, maxSuitcases: 8, baseFareLkr: 3000, perKmLkr: 180 },
};

// Approximate road distances from the airport (fictional data for the demo).
const DISTANCES_FROM_AIRPORT_KM: Record<string, number> = {
  negombo: 10,
  colombo: 35,
  'mount lavinia': 48,
  kandy: 105,
  sigiriya: 150,
  galle: 150,
  ella: 230,
};

const NIGHT_SURCHARGE = 0.1; // 10% between 22:00 and 05:59

export interface FareInput {
  vehicleType: string;
  destination?: string;
  distanceKm?: number;
  pickupHour?: number; // 0-23, local time
}

export function estimateFare({ vehicleType, destination, distanceKm, pickupHour }: FareInput) {
  const type = vehicleType.toLowerCase() as VehicleType;
  const vehicle = VEHICLES[type];
  if (!vehicle) {
    return { error: `Unknown vehicle type "${vehicleType}". Use one of: ${VEHICLE_TYPES.join(', ')}.` };
  }

  const km = distanceKm ?? (destination ? DISTANCES_FROM_AIRPORT_KM[destination.toLowerCase()] : undefined);
  if (km === undefined || km <= 0) {
    return {
      error: `Unknown distance for "${destination ?? ''}". Ask the customer for the distance in km.`,
      knownDestinations: Object.keys(DISTANCES_FROM_AIRPORT_KM),
    };
  }

  const isNight = pickupHour !== undefined && (pickupHour >= 22 || pickupHour < 6);
  const subtotal = vehicle.baseFareLkr + vehicle.perKmLkr * km;
  const total = Math.round((isNight ? subtotal * (1 + NIGHT_SURCHARGE) : subtotal) / 100) * 100;

  return {
    vehicle: vehicle.label,
    maxPassengers: vehicle.maxPassengers,
    maxSuitcases: vehicle.maxSuitcases,
    distanceKm: km,
    nightSurchargeApplied: isNight,
    estimatedFareLkr: total,
    note: 'Estimate only. The final price is confirmed at booking.',
  };
}

// Mock flight data. "FA" is a made-up airline code.
const FLIGHTS: Record<string, { from: string; scheduled: string; status: string; estimated: string }> = {
  FA101: { from: 'Dubai', scheduled: '08:40', status: 'Landed', estimated: '08:32' },
  FA245: { from: 'Singapore', scheduled: '13:15', status: 'Delayed', estimated: '13:55' },
  FA318: { from: 'Chennai', scheduled: '19:05', status: 'On time', estimated: '19:05' },
};

export function getFlightStatus({ flightNumber }: { flightNumber: string }) {
  const key = flightNumber.replace(/\s+/g, '').toUpperCase();
  const flight = FLIGHTS[key];
  if (!flight) return { error: `No flight found for "${flightNumber}".` };
  return { flightNumber: key, ...flight, timezone: 'local airport time' };
}
