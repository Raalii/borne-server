"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
// Charger les variables d'environnement
dotenv_1.default.config();
// Initialiser Prisma
const prisma = new client_1.PrismaClient({
    log: process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
});
// Configuration du serveur Express
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
// Configuration CORS pour Socket.io
const io = new socket_io_1.Server(server, {
    cors: {
        origin: process.env.CLIENT_URL || "http://localhost:3000",
        methods: ["GET", "POST"],
        credentials: true,
    },
});
// Middleware CORS pour Express
app.use((0, cors_1.default)({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
}));
app.use(express_1.default.json());
// Routes API Express
app.get("/", (req, res) => {
    res.send({ status: "Socket server is running" });
});
// Route pour récupérer les produits
app.get("/api/products", async (req, res) => {
    try {
        const products = await prisma.product.findMany({
            orderBy: {
                category: "asc",
            },
        });
        res.json({ products });
    }
    catch (error) {
        console.error("Erreur lors de la récupération des produits:", error);
        res
            .status(500)
            .json({ error: "Erreur lors de la récupération des produits" });
    }
});
// Route pour récupérer les commandes
app.get("/api/orders", async (req, res) => {
    try {
        const orders = await prisma.order.findMany({
            orderBy: {
                createdAt: "desc",
            },
            include: {
                items: true,
                statusHistory: {
                    orderBy: {
                        timestamp: "desc",
                    },
                },
            },
        });
        res.json({ orders });
    }
    catch (error) {
        console.error("Erreur lors de la récupération des commandes:", error);
        res
            .status(500)
            .json({ error: "Erreur lors de la récupération des commandes" });
    }
});
// Suivi des clients connectés
const connectedClients = {
    customer: new Set(),
    kitchen: new Set(),
};
// Fonction pour générer un numéro de commande unique
async function generateOrderNumber() {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
    // Compter les commandes du jour
    const todayStart = new Date(today.setHours(0, 0, 0, 0));
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);
    const todayOrdersCount = await prisma.order.count({
        where: {
            createdAt: {
                gte: todayStart,
                lte: todayEnd,
            },
        },
    });
    // Format: AAAAMMJJ-001, AAAAMMJJ-002, etc.
    const orderNumber = `${dateStr}-${String(todayOrdersCount + 1).padStart(3, "0")}`;
    return orderNumber;
}
// Fonction pour mapper les méthodes de paiement de l'interface vers Prisma
function mapPaymentMethod(method) {
    switch (method.toUpperCase()) {
        case "CB":
        case "CARD":
            return "CARD";
        case "ESPECES":
        case "CASH":
            return "CASH";
        case "PAYPAL":
            return "PAYPAL";
        default:
            return "CASH";
    }
}
// Fonction pour mettre à jour les stocks lorsqu'une commande est payée et en préparation
async function updateProductStock(order) {
    // Mettre à jour le stock uniquement si la commande est payée ET en préparation
    if (order.isPaid && order.status === "PREPARING") {
        console.log("Mise à jour des stocks pour la commande", order.id);
        // Récupérer les items de la commande pour mettre à jour les stocks
        const orderItems = await prisma.orderItem.findMany({
            where: { orderId: order.id },
            include: { product: true },
        });
        // Mettre à jour le stock de chaque produit
        for (const item of orderItems) {
            await prisma.product.update({
                where: { id: item.productId },
                data: {
                    stock: {
                        decrement: item.quantity, // Décrémenter le stock selon la quantité commandée
                    },
                    // Désactiver le produit si le stock devient épuisé
                    isAvailable: item.product.stock - item.quantity > 0,
                },
            });
            console.log(`Stock mis à jour pour le produit ${item.productId}: -${item.quantity}`);
        }
    }
}
// Fonction pour restaurer les stocks si une commande est annulée ou non payée
async function restoreProductStock(order, previousStatus) {
    // Restaurer le stock uniquement si:
    // 1. La commande passe de PREPARING à CANCELLED
    // 2. La commande était payée et passe à non payée alors qu'elle était en PREPARING
    const shouldRestoreStock = (previousStatus === "PREPARING" && order.status === "CANCELLED") ||
        (previousStatus === "PREPARING" &&
            order.status === "PREPARING" &&
            !order.isPaid);
    if (shouldRestoreStock) {
        console.log("Restauration des stocks pour la commande", order.id);
        // Récupérer les items de la commande pour restaurer les stocks
        const orderItems = await prisma.orderItem.findMany({
            where: { orderId: order.id },
            include: { product: true },
        });
        // Restaurer le stock de chaque produit
        for (const item of orderItems) {
            await prisma.product.update({
                where: { id: item.productId },
                data: {
                    stock: {
                        increment: item.quantity, // Incrémenter le stock selon la quantité restaurée
                    },
                    // Réactiver le produit si le stock est restauré
                    isAvailable: true,
                },
            });
            console.log(`Stock restauré pour le produit ${item.productId}: +${item.quantity}`);
        }
    }
}
// Gestion des connexions Socket.io
io.on("connection", (socket) => {
    console.log(`Client connecté: ${socket.id}`);
    // Enregistrer le type de client (client acheteur ou cuisine)
    socket.on("register", (data) => {
        const { clientType } = data;
        // Rejoindre la room correspondante au type de client
        socket.join(clientType);
        // Stocker l'ID du socket dans la liste appropriée
        connectedClients[clientType].add(socket.id);
        console.log(`Client ${socket.id} enregistré comme ${clientType}`);
        console.log(`Clients actuellement connectés: customers=${connectedClients.customer.size}, kitchen=${connectedClients.kitchen.size}`);
        // Informer les clients de type cuisine du nombre de clients connectés
        io.to("kitchen").emit("clients_count", {
            customers: connectedClients.customer.size,
            kitchen: connectedClients.kitchen.size,
        });
    });
    // Écouter les nouvelles commandes des clients
    socket.on("new_order", async (orderData) => {
        try {
            console.log("Nouvelle commande reçue:", orderData);
            // Générer un numéro de commande unique
            const orderNumber = await generateOrderNumber();
            // Mapper la méthode de paiement
            const paymentMethod = mapPaymentMethod(orderData.paiement);
            // Préparer les données pour Prisma
            const orderCreate = {
                number: orderNumber,
                customerName: orderData.nom,
                paymentMethod,
                totalAmount: parseFloat(orderData.total),
                isPaid: false, // Par défaut, la commande n'est pas payée
                status: "NEW",
                // Créer les items de la commande
                items: {
                    create: await Promise.all(orderData.panier.map(async (item) => {
                        // Trouver le produit correspondant
                        const product = await prisma.product.findFirst({
                            where: { id: item.id },
                        });
                        if (!product) {
                            throw new Error(`Produit non trouvé: ${item.id}`);
                        }
                        return {
                            quantity: item.quantity || 1,
                            unitPrice: item.prix,
                            productSnapshot: item,
                            product: {
                                connect: { id: product.id },
                            },
                        };
                    })),
                },
                // Créer l'historique initial
                statusHistory: {
                    create: {
                        status: "NEW",
                        note: "Commande créée",
                    },
                },
            };
            // Ajouter les instructions si présentes
            if (orderData.instructions) {
                // @ts-ignore - Ignorons l'erreur de type ici car instructions pourrait être dans le schéma
                orderCreate.instructions = orderData.instructions;
            }
            // Créer la commande en base de données
            const order = await prisma.order.create({
                data: orderCreate,
                include: {
                    items: true,
                    statusHistory: true,
                },
            });
            console.log("Commande créée en base de données:", order.id);
            // Envoyer la confirmation au client
            socket.emit("order_confirmation", {
                orderId: order.id,
                orderNumber: order.number,
            });
            // Formater les données pour l'interface cuisine
            const formattedItems = order.items.map((item) => {
                // Récupérer les données du productSnapshot en toute sécurité
                const snapshot = item.productSnapshot;
                return {
                    id: item.id,
                    nom: snapshot.nom || "Produit",
                    prix: item.unitPrice,
                    quantity: item.quantity,
                };
            });
            // Notifier tous les clients de type "cuisine"
            io.to("kitchen").emit("new_order_received", {
                id: order.id,
                number: order.number,
                nom: order.customerName,
                customerName: order.customerName,
                instructions: order.instructions || "",
                status: order.status,
                isPaid: order.isPaid,
                total: order.totalAmount.toFixed(2),
                totalAmount: order.totalAmount,
                createdAt: order.createdAt.toISOString(),
                updatedAt: order.updatedAt.toISOString(),
                panier: formattedItems,
                items: order.items,
            });
        }
        catch (error) {
            console.error("Erreur lors du traitement de la commande:", error);
            socket.emit("order_error", {
                message: "Erreur lors du traitement de la commande",
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
    // Mise à jour du statut d'une commande
    socket.on("update_order_status", async (data) => {
        try {
            console.log("Mise à jour du statut de commande:", data);
            // Récupérer la commande actuelle pour connaître son état précédent
            const currentOrder = await prisma.order.findUnique({
                where: { id: data.orderId },
            });
            if (!currentOrder) {
                throw new Error(`Commande non trouvée: ${data.orderId}`);
            }
            const previousStatus = currentOrder.status;
            const previousIsPaid = currentOrder.isPaid;
            // Préparer les données de mise à jour
            const updateData = {};
            if (data.status !== undefined)
                updateData.status = data.status;
            if (data.isPaid !== undefined)
                updateData.isPaid = data.isPaid;
            // Préparer l'historique si le statut a changé
            const historyCreate = data.status
                ? {
                    statusHistory: {
                        create: {
                            status: data.status,
                            note: data.note ||
                                `Statut modifié de ${previousStatus} à ${data.status}`,
                        },
                    },
                }
                : {};
            // Mettre à jour la commande en base de données
            const updatedOrder = await prisma.order.update({
                where: { id: data.orderId },
                data: {
                    ...updateData,
                    ...historyCreate,
                },
                include: {
                    items: {
                        include: {
                            product: true,
                        },
                    },
                    statusHistory: {
                        orderBy: {
                            timestamp: "desc",
                        },
                    },
                },
            });
            // Gérer la mise à jour des stocks
            // 1. Si la commande passe à "PREPARING" et est payée, décrémenter le stock
            if ((data.status === "PREPARING" && updatedOrder.isPaid) ||
                (previousStatus === "PREPARING" && data.isPaid === true)) {
                await updateProductStock(updatedOrder);
            }
            // 2. Si la commande est annulée ou si le paiement est annulé, restaurer le stock
            if ((previousStatus === "PREPARING" && data.status === "CANCELLED") ||
                (previousStatus === "PREPARING" &&
                    previousIsPaid &&
                    data.isPaid === false)) {
                await restoreProductStock(updatedOrder, previousStatus);
            }
            console.log("Commande mise à jour en base de données:", updatedOrder.id);
            // Formater les items pour l'interface client
            const formattedItems = updatedOrder.items.map((item) => {
                // Récupérer les données du productSnapshot en toute sécurité
                const snapshot = item.productSnapshot;
                return {
                    id: item.id,
                    nom: snapshot.nom || "Produit",
                    prix: item.unitPrice,
                    quantity: item.quantity,
                };
            });
            // Informer tous les clients concernés
            io.to("kitchen").emit("order_updated", {
                id: updatedOrder.id,
                number: updatedOrder.number,
                nom: updatedOrder.customerName,
                customerName: updatedOrder.customerName,
                instructions: updatedOrder.instructions || "",
                status: updatedOrder.status,
                isPaid: updatedOrder.isPaid,
                total: updatedOrder.totalAmount.toFixed(2),
                totalAmount: updatedOrder.totalAmount,
                createdAt: updatedOrder.createdAt.toISOString(),
                updatedAt: updatedOrder.updatedAt.toISOString(),
                panier: formattedItems,
                items: updatedOrder.items,
            });
            // Notifier tous les clients du changement de statut
            io.emit("order_status_changed", {
                orderId: updatedOrder.id,
                status: updatedOrder.status,
                isPaid: updatedOrder.isPaid,
                updatedAt: updatedOrder.updatedAt.toISOString(),
            });
            // Notifier les clients du changement de stock si nécessaire
            if ((data.status === "PREPARING" && updatedOrder.isPaid) ||
                (previousStatus === "PREPARING" && data.isPaid === true) ||
                (previousStatus === "PREPARING" && data.status === "CANCELLED") ||
                (previousStatus === "PREPARING" &&
                    previousIsPaid &&
                    data.isPaid === false)) {
                // Récupérer les produits mis à jour pour informer les clients
                const updatedProducts = await prisma.product.findMany({
                    where: {
                        id: {
                            in: updatedOrder.items.map((item) => item.productId),
                        },
                    },
                });
                io.emit("products_updated", { products: updatedProducts });
            }
        }
        catch (error) {
            console.error("Erreur lors de la mise à jour du statut:", error);
            socket.emit("update_error", {
                message: "Erreur lors de la mise à jour du statut",
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
    // Gérer la déconnexion
    socket.on("disconnect", () => {
        console.log(`Client déconnecté: ${socket.id}`);
        // Retirer le client des listes
        connectedClients.customer.delete(socket.id);
        connectedClients.kitchen.delete(socket.id);
        // Informer les clients de type cuisine
        io.to("kitchen").emit("clients_count", {
            customers: connectedClients.customer.size,
            kitchen: connectedClients.kitchen.size,
        });
    });
});
// Démarrer le serveur
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`Socket.io server running on port ${PORT}`);
});
// Gestion de l'arrêt propre du serveur
process.on("SIGINT", async () => {
    console.log("Arrêt du serveur...");
    await prisma.$disconnect();
    process.exit(0);
});
