import { Button } from "@odin/ui/button";
import { Input } from "@odin/ui/input";
import { toast } from "@odin/ui/sonner";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { LuTrash2 } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	SettingRow,
	SettingsPage,
	SettingsSection,
	StatusDot,
} from "../components/SettingsPage";

export const Route = createFileRoute("/_authenticated/settings/remote-server/")(
	{
		component: RemoteServerSettings,
	},
);

interface ConnectionForm {
	name: string;
	host: string;
	sshPort: string;
	username: string;
	sshKeyPath: string;
	odinFolder: string;
	remoteHostServicePort: string;
}

const EMPTY_FORM: ConnectionForm = {
	name: "",
	host: "",
	sshPort: "22",
	username: "",
	sshKeyPath: "",
	odinFolder: "~/.odin",
	remoteHostServicePort: "48000",
};

function RemoteServerSettings() {
	const utils = electronTrpc.useUtils();
	const { data: connections = [] } =
		electronTrpc.remoteConnections.list.useQuery();
	const { data: active } = electronTrpc.remoteConnections.getActive.useQuery(
		undefined,
		{ refetchInterval: 5_000 },
	);

	electronTrpc.remoteConnections.onStatusChange.useSubscription(undefined, {
		onData: () => utils.remoteConnections.getActive.invalidate(),
	});

	const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM);

	const refresh = () => {
		utils.remoteConnections.list.invalidate();
		utils.remoteConnections.getActive.invalidate();
	};

	const create = electronTrpc.remoteConnections.create.useMutation({
		onSuccess: () => {
			setForm(EMPTY_FORM);
			refresh();
			toast.success("Remote connection saved.");
		},
		onError: (error) => toast.error(error.message),
	});
	const remove = electronTrpc.remoteConnections.delete.useMutation({
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	const connect = electronTrpc.remoteConnections.connect.useMutation({
		onSuccess: () => {
			refresh();
			toast.success("Connected to the remote backend.");
		},
		onError: (error) => toast.error(`Connect failed: ${error.message}`),
	});
	const disconnect = electronTrpc.remoteConnections.disconnect.useMutation({
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	const test = electronTrpc.remoteConnections.testConnection.useMutation();

	const canSave =
		form.name.trim() &&
		form.host.trim() &&
		form.username.trim() &&
		form.odinFolder.trim();

	const save = () => {
		create.mutate({
			name: form.name.trim(),
			host: form.host.trim(),
			sshPort: Number(form.sshPort) || 22,
			username: form.username.trim(),
			sshKeyPath: form.sshKeyPath.trim() || null,
			odinFolder: form.odinFolder.trim(),
			remoteHostServicePort: Number(form.remoteHostServicePort) || 48000,
		});
	};

	const field = (key: keyof ConnectionForm) => ({
		value: form[key],
		onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
			setForm((prev) => ({ ...prev, [key]: event.target.value })),
	});

	return (
		<SettingsPage
			title="Remote server"
			description="Run Odin's backend on an SSH-reachable machine so agents keep running when this computer is asleep or closed. Only the path to your SSH key is stored - never the key itself."
		>
			<SettingsSection
				title="Remote server"
				description="Configured machines Odin can run its backend on."
			>
				{connections.length === 0 ? (
					<SettingRow
						label="No connections yet"
						description="Add one below, then connect from here or the home top bar."
					/>
				) : (
					connections.map((connection) => {
						const isActive =
							active?.connectionId === connection.id &&
							active.status === "connected";
						const isConnecting =
							active?.connectionId === connection.id &&
							active.status === "connecting";
						return (
							<SettingRow
								key={connection.id}
								label={connection.name}
								description={`${connection.username}@${connection.host}:${connection.sshPort} - ${connection.odinFolder}`}
							>
								<StatusDot
									loading={isConnecting}
									configured={isActive}
									identity={isActive ? "Connected" : null}
									error={null}
								/>
								<Button
									variant="outline"
									size="sm"
									disabled={test.isPending}
									onClick={async () => {
										const result = await test.mutateAsync({
											id: connection.id,
										});
										if (result.ok) toast.success(result.message);
										else toast.error(result.message);
									}}
								>
									Test
								</Button>
								{isActive ? (
									<Button
										variant="outline"
										size="sm"
										disabled={disconnect.isPending}
										onClick={() => disconnect.mutate()}
									>
										Disconnect
									</Button>
								) : (
									<Button
										variant="outline"
										size="sm"
										disabled={connect.isPending}
										onClick={() => connect.mutate({ id: connection.id })}
									>
										Connect
									</Button>
								)}
								<Button
									variant="ghost"
									size="icon"
									aria-label="Delete connection"
									disabled={remove.isPending}
									onClick={() => remove.mutate({ id: connection.id })}
								>
									<LuTrash2 className="size-4" />
								</Button>
							</SettingRow>
						);
					})
				)}
			</SettingsSection>

			<SettingsSection
				title="Add a connection"
				description="Key-based SSH only. Point the odin folder at a writable path on the remote - it holds the backend's logs, database and worktrees."
			>
				<SettingRow label="Name" htmlFor="remote-name">
					<Input
						id="remote-name"
						className="w-64"
						placeholder="Build box"
						{...field("name")}
					/>
				</SettingRow>
				<SettingRow label="Server address" htmlFor="remote-host">
					<Input
						id="remote-host"
						className="w-64"
						placeholder="10.0.0.42 or build.example.com"
						{...field("host")}
					/>
				</SettingRow>
				<SettingRow label="SSH username" htmlFor="remote-username">
					<Input
						id="remote-username"
						className="w-64"
						placeholder="ubuntu"
						{...field("username")}
					/>
				</SettingRow>
				<SettingRow label="SSH port" htmlFor="remote-ssh-port">
					<Input
						id="remote-ssh-port"
						type="number"
						className="w-28 tabular-nums"
						{...field("sshPort")}
					/>
				</SettingRow>
				<SettingRow
					label="SSH key path"
					htmlFor="remote-key"
					description="Leave blank to use your SSH agent or default identity."
				>
					<Input
						id="remote-key"
						className="w-64"
						placeholder="~/.ssh/id_ed25519"
						{...field("sshKeyPath")}
					/>
				</SettingRow>
				<SettingRow label="Odin folder" htmlFor="remote-folder">
					<Input
						id="remote-folder"
						className="w-64"
						placeholder="~/.odin"
						{...field("odinFolder")}
					/>
				</SettingRow>
				<SettingRow
					label="Host-service port"
					htmlFor="remote-service-port"
					description="Port the backend listens on remotely, forwarded over the SSH tunnel."
				>
					<Input
						id="remote-service-port"
						type="number"
						className="w-28 tabular-nums"
						{...field("remoteHostServicePort")}
					/>
				</SettingRow>
				<SettingRow label="Save connection">
					<Button
						size="sm"
						disabled={!canSave || create.isPending}
						onClick={save}
					>
						Save
					</Button>
				</SettingRow>
			</SettingsSection>
		</SettingsPage>
	);
}
