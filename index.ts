import {
  Attachment,
  Client,
  Events,
  GatewayIntentBits,
  GuildPremiumTier,
  Message,
  Options,
} from 'discord.js'
import stripEmoji from 'emoji-strip'
import { mightFail } from 'might-fail'
import { RateLimiterMemory } from 'rate-limiter-flexible'

if (
  !process.env.DISCORD_TOKEN ||
  !process.env.SERVER_ID ||
  !process.env.SOURCE_CHANNEL_ID ||
  !process.env.DESTINATION_CHANNEL_ID
) {
  throw new Error('Missing env variables')
}

const discordToken = process.env.DISCORD_TOKEN
const serverId = process.env.SERVER_ID
const sourceChannelId = process.env.SOURCE_CHANNEL_ID
const destinationChannelId = process.env.DESTINATION_CHANNEL_ID

const MiB = 1024 * 1024

// Per-file upload limit for each boost tier of the destination server.
const uploadLimits = {
  [GuildPremiumTier.None]: 20 * MiB,
  [GuildPremiumTier.Tier1]: 20 * MiB,
  [GuildPremiumTier.Tier2]: 50 * MiB,
  [GuildPremiumTier.Tier3]: 100 * MiB,
}

const createMessageLink = (message: Message) =>
  `https://discord.com/channels/${serverId}/${message.channelId}`

const attachmentLabel = ({ contentType }: Attachment) => {
  if (contentType?.startsWith('image/')) return '[image]'
  if (contentType?.startsWith('video/')) return '[video]'
  if (contentType?.startsWith('audio/')) return '[audio]'
  return '[file]'
}

const stripMentions = (content: string) => content.replace(/<@!?\d+>/g, '`@mention`')

const rateLimiter = new RateLimiterMemory({ points: 4, duration: 60 * 60 * 12 }) // 4 messages per 12 hours

let lastThreadId: string | null = null

export const connectDiscord = () => {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // Only channels and threads are needed, not the last 200 messages of every channel.
    makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
  })

  client.once(Events.ClientReady, () => console.log(`Logged in to Discord as ${client.user?.tag}`))

  const forwardMessage = async (message: Message) => {
    const [error, result] = await mightFail(rateLimiter.consume(message.channelId, 1))

    if (error) return

    const destinationChannel = await client.channels.fetch(destinationChannelId)
    if (!destinationChannel) return

    if (message.content.length === 0 && message.attachments.size === 0) return

    // @ts-expect-error
    if (message.channel.parentId === sourceChannelId) {
      const truncatedChannelName =
        // @ts-expect-error
        message.channel.name.length > 40
          ? // @ts-expect-error
            message.channel.name.slice(0, 35) + '[...]'
          : // @ts-expect-error
            message.channel.name

      if (lastThreadId !== message.channelId) {
        // @ts-expect-error
        await destinationChannel.send(
          `🧵 ${`[**${stripEmoji(
            truncatedChannelName
          ).trim()}**](<https://discord.com/channels/${serverId}/${message.channelId}>)`}`
        )
        lastThreadId = message.channelId
      }

      const truncatedContent =
        message.content.length > 200 ? message.content.slice(0, 195) + '[...]' : message.content

      const createDestinationMessage = (notForwarded: typeof message.attachments) => {
        const text = [stripMentions(truncatedContent), ...notForwarded.map(attachmentLabel)]
          .filter(Boolean)
          .join(' ')

        return `**${message.author.displayName}**: ${text}`
      }

      // Only images are forwarded. discord.js downloads them into memory to re-upload them, so
      // whatever Discord would reject has to be skipped before it is fetched. The limit is per
      // file, but it is also applied to the whole message to bound how much memory it can use.
      // @ts-expect-error
      let uploadBudget: number = uploadLimits[destinationChannel.guild.premiumTier]
      const [images, notForwarded] = message.attachments.partition(({ contentType, size }) => {
        if (!contentType?.startsWith('image/') || size > uploadBudget) return false
        uploadBudget -= size
        return true
      })

      try {
        // @ts-expect-error
        await destinationChannel.send({
          content: createDestinationMessage(notForwarded),
          files: images.map(image => ({ attachment: image.url })),
        })
      } catch (uploadError) {
        if (images.size === 0) throw uploadError
        console.error(`Could not upload images of ${message.url}:`, uploadError)
        // @ts-expect-error
        await destinationChannel.send(createDestinationMessage(message.attachments))
      } finally {
        // Otherwise downloaded images pile up in memory until the next natural GC. The delay lets
        // the request release them first: a GC right away would still see them as in use.
        if (images.size > 0) setTimeout(() => Bun.gc(true), 1000)
      }

      if (result.remainingPoints === 0) {
        // @ts-expect-error
        await destinationChannel.send(
          `:zzz: Message forwarding for this [thread](<${createMessageLink(
            message
          )}>) is paused for a bit!`
        )
      }
    }
  }

  client.on(Events.MessageCreate, message => {
    forwardMessage(message).catch(error =>
      console.error(`Could not forward ${message.url}:`, error)
    )
  })

  client.login(discordToken)

  return () => client.destroy()
}

Bun.serve({ fetch: () => new Response('ok') })

const disconnectDiscord = connectDiscord()

const cleanup = async () => {
  await disconnectDiscord()
  process.exit(0)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
