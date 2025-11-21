import {
   SlashCommandBuilder,
   ContainerBuilder,
   TextDisplayBuilder,
   MediaGalleryBuilder,
   SeparatorBuilder,
   MessageFlags
} from "discord.js";

export const data = new SlashCommandBuilder()
   .setName("magnify")
   .setDescription(
      "Send a Components V2 message that matches the JSON example"
   );

export async function execute(interaction) {
   // First text block
   const text1 = new TextDisplayBuilder().setContent(
      "-# add a giant magnifying glass"
   );

   // First media gallery (image)
   const gallery1 = new MediaGalleryBuilder().addItems((item) =>
      item.setURL(
         "https://cdn.discordapp.com/ephemeral-attachments/1170494279261634672/1393558719752831037/78c3de34-a4a5-4fa8-b786-ecf5785577cb.jpg"
      )
   );

   // Divider
   const divider = new SeparatorBuilder().setDivider(true).setSpacing(1);

   // Second text block
   const text2 = new TextDisplayBuilder().setContent(
      "I will add a giant magnifying glass that is partially visible, as if resting on the grassy area in front of the bushes, slightly angled to show its scale against the greenery."
   );

   // Second media gallery (image)
   const gallery2 = new MediaGalleryBuilder().addItems((item) =>
      item.setURL(
         "https://cdn.discordapp.com/attachments/1375573228864405534/1393558746772279417/prism-cict8c0ifsj.png"
      )
   );

   // Wrap everything in a container
   const container = new ContainerBuilder()
      .addTextDisplayComponents(text1)
      .addMediaGalleryComponents(gallery1)
      .addSeparatorComponents(divider)
      .addTextDisplayComponents(text2)
      .addMediaGalleryComponents(gallery2);

   // Send the message
   await interaction.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2
   });
}
