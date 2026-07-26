import { prisma } from './client';

async function main(): Promise<void> {
  const users = [
    { name: 'Alice', credits: 5 },
    { name: 'Bob', credits: 1 },
    { name: 'Sem Creditos', credits: 0 },
  ];

  for (const user of users) {
    const created = await prisma.user.create({ data: user });
    console.log(`Created user ${created.name} (${created.id}) with ${created.credits} credits`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
