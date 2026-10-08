import { remoteConnections } from "@odin/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import {
	getRemoteConnectionManager,
	type RemoteConnectionConfig,
	type RemoteConnectionStatusEvent,
} from "main/lib/remote-connection";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const connectionInput = z.object({
	name: z.string().min(1),
	host: z.string().min(1),
	sshPort: z.number().int().positive().max(65_535).default(22),
	username: z.string().min(1),
	sshKeyPath: z.string().nullable().default(null),
	odinFolder: z.string().min(1),
	remoteHostServicePort: z
		.number()
		.int()
		.positive()
		.max(65_535)
		.default(48_000),
});

const idInput = z.object({ id: z.string().min(1) });

function toConfig(
	row: typeof remoteConnections.$inferSelect,
): RemoteConnectionConfig {
	return {
		id: row.id,
		name: row.name,
		host: row.host,
		sshPort: row.sshPort,
		username: row.username,
		sshKeyPath: row.sshKeyPath,
		odinFolder: row.odinFolder,
		remoteHostServicePort: row.remoteHostServicePort,
	};
}

function requireRow(id: string): typeof remoteConnections.$inferSelect {
	const row = localDb
		.select()
		.from(remoteConnections)
		.where(eq(remoteConnections.id, id))
		.get();
	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Remote connection ${id} not found`,
		});
	}
	return row;
}

export const createRemoteConnectionsRouter = () => {
	return router({
		list: publicProcedure.query(() => {
			return localDb.select().from(remoteConnections).all();
		}),

		get: publicProcedure.input(idInput).query(({ input }) => {
			return requireRow(input.id);
		}),

		getActive: publicProcedure.query(() => {
			return getRemoteConnectionManager().getActive();
		}),

		create: publicProcedure.input(connectionInput).mutation(({ input }) => {
			return localDb
				.insert(remoteConnections)
				.values({ ...input })
				.returning()
				.get();
		}),

		update: publicProcedure
			.input(idInput.extend(connectionInput.partial().shape))
			.mutation(({ input }) => {
				const { id, ...patch } = input;
				requireRow(id);
				return localDb
					.update(remoteConnections)
					.set({ ...patch, updatedAt: Date.now() })
					.where(eq(remoteConnections.id, id))
					.returning()
					.get();
			}),

		delete: publicProcedure.input(idInput).mutation(({ input }) => {
			const active = getRemoteConnectionManager().getActive();
			if (active?.connectionId === input.id) {
				getRemoteConnectionManager().disconnect();
			}
			localDb
				.delete(remoteConnections)
				.where(eq(remoteConnections.id, input.id))
				.run();
			return { success: true };
		}),

		testConnection: publicProcedure
			.input(idInput)
			.mutation(async ({ input }) => {
				const row = requireRow(input.id);
				return getRemoteConnectionManager().testConnection(toConfig(row));
			}),

		connect: publicProcedure.input(idInput).mutation(async ({ input }) => {
			const row = requireRow(input.id);
			const active = await getRemoteConnectionManager().connect(toConfig(row));
			// Reflect the active flag in the DB so the UI survives a reload.
			localDb
				.update(remoteConnections)
				.set({ isActive: false })
				.where(eq(remoteConnections.isActive, true))
				.run();
			localDb
				.update(remoteConnections)
				.set({ isActive: true })
				.where(eq(remoteConnections.id, input.id))
				.run();
			return active;
		}),

		disconnect: publicProcedure.mutation(() => {
			getRemoteConnectionManager().disconnect();
			localDb
				.update(remoteConnections)
				.set({ isActive: false })
				.where(eq(remoteConnections.isActive, true))
				.run();
			return { success: true };
		}),

		onStatusChange: publicProcedure.subscription(() => {
			return observable<RemoteConnectionStatusEvent>((emit) => {
				return getRemoteConnectionManager().onStatusChange((event) =>
					emit.next(event),
				);
			});
		}),
	});
};
