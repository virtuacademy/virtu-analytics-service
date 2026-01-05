import { prisma } from "@/lib/prisma";

export const typeDefs = /* GraphQL */ `
  type Attribution {
    token: ID!
    firstTouchAt: String!
    lastTouchAt: String!
    utmSource: String
    utmMedium: String
    utmCampaign: String
    gclid: String
    fbclid: String
    ttclid: String
    fbp: String
    fbc: String
    lastUrl: String
    lastReferrer: String
  }

  type Appointment {
    id: ID!
    appointmentTypeId: String
    status: String
    datetime: String
    email: String
    phone: String
    firstName: String
    lastName: String
    vaAttrib: String
    gclid: String
    ttclid: String
    fbp: String
    fbc: String
  }

  type Delivery {
    platform: String!
    status: String!
    attempts: Int!
    lastAttemptAt: String
    responseCode: Int
    responseBody: String
  }

  type CanonicalEvent {
    id: ID!
    name: String!
    eventTime: String!
    appointmentId: String
    attributionTok: String
    eventId: String!
    deliveries: [Delivery!]!
  }

  type Query {
    attribution(token: ID!): Attribution
    appointment(id: ID!): Appointment
    canonicalEventsByAppointment(appointmentId: ID!): [CanonicalEvent!]!
  }
`;

export const resolvers = {
  Query: {
    attribution: async (_: unknown, args: { token: string }) =>
      prisma.attribution.findUnique({ where: { token: args.token } }),
    appointment: async (_: unknown, args: { id: string }) =>
      prisma.appointment.findUnique({ where: { id: args.id } }),
    canonicalEventsByAppointment: async (_: unknown, args: { appointmentId: string }) =>
      prisma.canonicalEvent.findMany({
        where: { appointmentId: args.appointmentId },
        orderBy: { createdAt: "desc" },
        include: { deliveries: true }
      })
  }
};
