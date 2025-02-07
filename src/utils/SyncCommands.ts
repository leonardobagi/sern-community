import type {
	BothCommand,
	CommandModule,
	ContextMenuMsg,
	ContextMenuUser,
	SlashCommand,
} from "@sern/handler";
import { CommandType } from "@sern/handler";
import type {
	APIApplicationCommandOption,
	ApplicationCommand,
	Client,
	Guild,
} from "discord.js";
import { ApplicationCommandType, basename } from "discord.js";
import { readdir } from "fs/promises";
import path from "path";
import type { SernLogger } from "./Logger";

async function* getFiles(dir: string): AsyncGenerator<string> {
	const dirents = await readdir(dir, { withFileTypes: true });
	for (const dirent of dirents) {
		const res = path.resolve(dir, dirent.name);
		if (dirent.isDirectory()) {
			yield* getFiles(res);
		} else {
			yield res;
		}
	}
}

export class CommandSyncer {
	private commandsPath = "dist/src/commands";

	private debug(message: string) {
		this.logger.debug({ message });
	}

	constructor(
		private logger: SernLogger,
		private client: Client,
		private scopedGuilds: string[] = []
	) {
		this.sync()
			.catch((e) =>
				logger.error({ message: e ?? "Something went wrong with syncing" })
			)
			.then(() => logger.info({ message: "Commands synced successfully" }));
	}

	/** Returns true if a `CommandModule` is publishable */
	private publishable(module: CommandModule): module is Publishable {
		const publishableTypes =
			CommandType.Both |
			CommandType.CtxUser |
			CommandType.CtxMsg |
			CommandType.Slash;
		return (publishableTypes & ~CommandType.Text & module.type) != 0;
	}

	/** Handles a slash command module. */
	private async handleCommand(module: Publishable, resolvedName: string) {
		this.debug(`Checking if ${resolvedName} is already registered`);

		if (this.scopedGuilds.length)
			await this.handleScopedGuildsCommand(resolvedName, module);
		else await this.handleGlobalCommand(resolvedName, module);
	}

	private async handleGlobalCommand(resolvedName: string, module: Publishable) {
		this.debug(
			`Fetching (or retrieving from cache, if available) global commands.`
		);

		const commands = await this.client.application!.commands.fetch();

		const registeredCommand = commands.find((e) => e.name === resolvedName);
		if (registeredCommand) {
			this.debug(`Updating global ${resolvedName} command.`);

			await this.updateCommand(registeredCommand, module, resolvedName);
		} else {
			this.debug(`Registering global command ${resolvedName}.`);

			await this.registerGlobalCommand(resolvedName, module);
		}
	}

	private async handleScopedGuildsCommand(
		resolvedName: string,
		module: Publishable
	) {
		for (const guildId of this.scopedGuilds) {
			const guild = await this.client.guilds.fetch(guildId).catch(() => null);

			if (!guild) throw new Error(`Found no Guild with id ${guildId}!`);

			this.debug(
				`Fetching (or retrieving from cache, if available) guild ${guild.name} (${guild.id}) commands...`
			);

			const commands = await guild.commands.fetch();
			const registeredCommand = commands.find((e) => e.name === resolvedName);

			if (registeredCommand) {
				this.debug(`Updating command ${resolvedName}...`);

				await this.updateCommand(registeredCommand, module, resolvedName);
			} else {
				this.debug(`Registering ${resolvedName} command.`);

				await this.registerGuildCommand(guild, resolvedName, module);
			}
		}
	}

	private async registerGuildCommand(
		guild: Guild,
		resolvedName: string,
		module: Publishable
	) {
		await guild.commands.create({
			name: resolvedName,
			description: module.description ?? "..",
			type: ApplicationCommandType.ChatInput,
			options: this.optionsTransformer(
				module ?? []
			) as APIApplicationCommandOption[],
		});

		this.debug(
			`Command ${resolvedName} registered to guild ${guild.name} (${guild.id})`
		);
	}

	private async registerGlobalCommand(
		resolvedName: string,
		module: Publishable
	) {
		await this.client.application!.commands.create({
			name: resolvedName,
			description: module.description ?? "..",
			type: ApplicationCommandType.ChatInput,
			options: this.optionsTransformer(module) as APIApplicationCommandOption[],
		});

		this.debug(`Global command ${resolvedName} created.`);
	}

	private async updateCommand(
		registeredCommand: ApplicationCommand,
		module: Publishable,
		resolvedName: string
	) {
		await registeredCommand.edit({
			name: module.name,
			description: module.description,
			options: this.optionsTransformer(
				module ?? []
			) as APIApplicationCommandOption[],
			type: ApplicationCommandType.ChatInput,
		});

		this.debug(`Command ${resolvedName} updated`);
	}

	/** Parses the `module` options into the correct format. (Since ContextMenus are sent differently than ApplicationCommands)
	 */
	private optionsTransformer(module: Publishable) {
		if (module.type === CommandType.Slash || module.type === CommandType.Both)
			return (
				module.options?.map((el) =>
					el.autocomplete ? (({ command, ...el }) => el)(el) : el
				) || []
			);
		else return undefined;
	}

	/** Syncs application commands */
	public async sync() {
		this.logger.info({ message: "Syncing commands" });

		for await (const path of getFiles(this.commandsPath)) {
			const module = (await import("file:///" + path).then(
				(imp) => imp.default
			)) as CommandModule; //i would retrieve from the module store, but its a little bugged since

			if (this.publishable(module)) {
				const resolvedName = module.name ?? basename(path).slice(0, -3);
				await this.handleCommand(module, resolvedName);
			}
		}
	}
}

export type Publishable =
	| SlashCommand
	| BothCommand
	| ContextMenuMsg
	| ContextMenuUser;
