import { apiResponse, STORE_PLATFORM_CHARGE_TYPE } from '../../common';
import { itemModel, saleModel, stockModel, storeModel } from '../../database';
import { reqInfo, responseMessage } from '../../helper';
import { generateInvoiceNumber } from '../../helper/utils';

const ObjectId = require("mongoose").Types.ObjectId

// Helper function to get start and end of day
const getStartAndEndOfDay = (date) => {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    return { start, end };
};

// Helper function to get or create today's stock entry
const getOrCreateTodayStock = async (itemId) => {
    const today = new Date();
    const { start: startOfToday, end: endOfToday } = await getStartAndEndOfDay(today);

    let todayStock = await stockModel.findOne({
        itemId: new ObjectId(itemId),
        date: {
            $gte: startOfToday,
            $lte: endOfToday
        },
        isDeleted: false
    });

    if (!todayStock) {
        const yesterdayStock: any = await stockModel.findOne({
            itemId: new ObjectId(itemId),
            date: { $lt: startOfToday },
            isDeleted: false
        }).sort({ date: -1 }).lean();

        todayStock = await new stockModel({
            itemId,
            date: today,
            openingStock: yesterdayStock ? yesterdayStock.closingStock : 0,
            closingStock: yesterdayStock ? yesterdayStock.closingStock : 0
        }).save();
    }

    return todayStock;
};

export const createSale = async (req, res) => {
    reqInfo(req);
    let { user } = req.headers, { items, paymentMode, customerName, mobile } = req.body;
    try {
        const date = new Date();

        // Get store details for platform charge
        const store = await storeModel.findOne({ _id: new ObjectId(user.storeId) }).lean();
        if (!store) {
            return res.status(400).json(new apiResponse(400, "Store not found", {}, {}, {}));
        }

        // Calculate totals and validate stock
        let total = 0;
        let totalCost = 0;
        let saleItems = [];
        let totalItems = 0; // Count total items for fixed platform charge

        for (const item of items) {
            const itemDetails = await itemModel.findOne({ _id: new ObjectId(item.itemId) }).lean();
            if (!itemDetails) {
                return res.status(400).json(new apiResponse(400, responseMessage.getDataNotFound("item"), {}, {}, {}))
            }

            let quantityGram = 0, quantity = 0, unitPrice = 0, totalPrice = 0;

            if (itemDetails.pricingType === 'weight') {
                unitPrice = Number(itemDetails.perKgPrice) / 1000 || 0;
                const itemCost = Number(itemDetails.perKgCost) / 1000 || 0;

                if (item.inputType === "weight") {
                    quantityGram = Number(item.value) || 0;
                    totalPrice = unitPrice * quantityGram;
                } else if (item.inputType === "price") {
                    totalPrice = Number(item.value) || 0;
                    quantityGram = unitPrice ? totalPrice / unitPrice : 0;
                } else {
                    return res.status(400).json(new apiResponse(400, "Invalid inputType for weight-based item", {}, {}, {}));
                }
                quantity = 0; // Not used for weight-based

                // Calculate cost for weight-based items
                totalCost += itemCost * quantityGram;
                // Count as 1 item for platform charge
                totalItems += 1;
            } else if (itemDetails.pricingType === 'fixed') {
                // For fixed items, use perItemPrice and perItemCost
                unitPrice = Number(itemDetails['perItemPrice']) || 0;
                const itemCost = Number(itemDetails['perItemCost']) || 0;

                if (item.inputType === "quantity") {
                    quantity = Number(item.value) || 0;
                    totalPrice = unitPrice * quantity;
                } else if (item.inputType === "price") {
                    totalPrice = Number(item.value) || 0;
                    quantity = unitPrice ? totalPrice / unitPrice : 0;
                } else {
                    return res.status(400).json(new apiResponse(400, "Invalid inputType for fixed-price item", {}, {}, {}));
                }
                quantityGram = quantity; // For fixed items, quantityGram equals quantity

                // Calculate cost for fixed items
                totalCost += itemCost * quantity;
                totalItems += 1;
                // Add to total items count for platform charge
            } else {
                return res.status(400).json(new apiResponse(400, "Unknown pricingType", {}, {}, {}));
            }

            // Ensure all values are numbers and not NaN
            quantityGram = Number(quantityGram) || 0;
            quantity = Number(quantity) || 0;
            unitPrice = Number(unitPrice) || 0;
            totalPrice = Number(totalPrice) || 0;

            // If totalPrice or quantityGram is 0, return error
            if (totalPrice <= 0) {
                return res.status(400).json(new apiResponse(400, "Total price must be greater than zero", {}, {}, {}));
            }
            if (itemDetails.pricingType === 'weight' && quantityGram <= 0) {
                return res.status(400).json(new apiResponse(400, "Quantity (gram) must be greater than zero for weight-based items", {}, {}, {}));
            }
            if (itemDetails.pricingType === 'fixed' && quantity <= 0) {
                return res.status(400).json(new apiResponse(400, "Quantity (pieces) must be greater than zero for fixed-price items", {}, {}, {}));
            }

            // Stock check and update
            const todayStock = await getOrCreateTodayStock(item.itemId);
            const stockToCheck = itemDetails.pricingType === 'weight' ? quantityGram : quantity;
            if ((Number(todayStock.closingStock) || 0) < stockToCheck) {
                return res.status(400).json(new apiResponse(400, responseMessage.insufficientStock, {}, {}, {}));
            }
            const prevRemovedStock = Number(todayStock.removedStock) || 0;
            todayStock.removedStock = prevRemovedStock + stockToCheck;
            const openingStock = Number(todayStock.openingStock) || 0;
            const addedStock = Number(todayStock.addedStock) || 0;
            const removedStock = Number(todayStock.removedStock) || 0;
            todayStock.closingStock = openingStock + addedStock - removedStock;
            await todayStock.save();

            saleItems.push({
                itemId: item.itemId,
                itemName: itemDetails.name,
                quantityGram: quantityGram,
                unitPrice: unitPrice,
                totalPrice: totalPrice
            });

            total += totalPrice;
        }

        // After loop
        total = Number(total) || 0;
        totalCost = Number(totalCost) || 0;
        
        // Validate total cost is not greater than total price
        if (totalCost > total) {
            return res.status(400).json(new apiResponse(400, "Total cost cannot be greater than total price", {}, {}, {}));
        }

        const profit = total - totalCost;

        // Calculate platform charge
        let platformCharge = 0;
        if (store.platformCharge.type === STORE_PLATFORM_CHARGE_TYPE.FIXED) {
            platformCharge = store.platformCharge.value * totalItems;
        } else if (store.platformCharge.type === STORE_PLATFORM_CHARGE_TYPE.PERCENTAGE) {
            platformCharge = (total * store.platformCharge.value) / 100;
        }

        const invoiceNumber = await generateInvoiceNumber();

        const sale = new saleModel({
            items: saleItems,
            paymentMode,
            customerName,
            mobile,
            storeId: new ObjectId(user.storeId),
            userId: new ObjectId(user._id),
            date,
            total,
            totalCost,
            profit,
            platformCharge,
            invoiceNumber
        });

        await sale.save();

        return res.status(200).json(new apiResponse(200, responseMessage.addDataSuccess("sale"), sale, {}, {}))
    } catch (error) {
        console.log(error)
        return res.status(500).json(new apiResponse(500, responseMessage.internalServerError, {}, error, {}))
    }
};

export const getSales = async (req, res) => {
    let { startDate, endDate, userId } = req.query;
    try {
        const query: any = {};

        if (startDate && endDate) {
            query.date = {
                $gte: new Date(startDate as string),
                $lte: new Date(endDate as string)
            };
        }

        if (userId) query.userId = userId;
        
        const sales = await saleModel.find(query).populate('userId', 'name').populate('items.itemId', 'name');

        return res.status(200).json(new apiResponse(200, responseMessage.getDataSuccess("sales"), sales, {}, {}))
    } catch (error) {
        console.log(error)
        return res.status(500).json(new apiResponse(500, responseMessage.internalServerError, {}, error, {}))
    }
};

export const getSale = async (req, res) => {
    try {
        const sale = await saleModel.findOne({ _id: new ObjectId(req.params.id) }).lean()
            .populate('userId', 'name')
            .populate('items.itemId', 'name');

        if (!sale) return res.status(404).json(new apiResponse(404, responseMessage.getDataNotFound("sale"), {}, {}, {}))

        return res.status(200).json(new apiResponse(200, responseMessage.getDataSuccess("sale"), sale, {}, {}))
    } catch (error) {
        console.log(error)
        return res.status(500).json(new apiResponse(500, responseMessage.internalServerError, {}, error, {}))
    }
};

export const getSoldItems = async (req, res) => {
    reqInfo(req);
    let { dateFilter } = req.body, { user } = req.headers;
    try {
        const soldItems = await saleModel.aggregate([
            { $unwind: "$items" },
            {
                $group: {
                    _id: "$items.itemId",
                    totalQty: { $sum: "$items.quantityGram" }
                }
            },
            {
                $lookup: {
                    from: "items",
                    localField: "_id",
                    foreignField: "_id",
                    as: "item"
                }
            },
            { $unwind: "$item" },
            {
                $project: {
                    itemName: "$item.name",
                    totalQty: 1
                }
            }
        ]);

        return res.status(200).json(new apiResponse(200, responseMessage.getDataSuccess("sold items"), soldItems, {}, {}));
    } catch (error) {
        console.log(error);
        return res.status(500).json(new apiResponse(500, responseMessage.internalServerError, {}, error, {}));
    }
};

export const getCollection = async (req, res) => {
    reqInfo(req);
    let { user } = req.headers;
    try {
        const collection = await saleModel.aggregate([
            { $match: { storeId: new ObjectId(user.storeId) } },
            { $unwind: "$items" },
            {
                $group: {
                    _id: { itemId: "$items.itemId", paymentMode: "$paymentMode" },
                    totalAmount: { $sum: "$items.totalPrice" }
                }
            },
            {
                $group: {
                    _id: "$_id.itemId",
                    cash: {
                        $sum: {
                            $cond: [{ $eq: ["$_id.paymentMode", "cash"] }, "$totalAmount", 0]
                        }
                    },
                    online: {
                        $sum: {
                            $cond: [{ $eq: ["$_id.paymentMode", "online"] }, "$totalAmount", 0]
                        }
                    }
                }
            },
            {
                $lookup: {
                    from: "items",
                    localField: "_id",
                    foreignField: "_id",
                    as: "item"
                }
            },
            { $unwind: "$item" },
            {
                $project: {
                    itemName: "$item.name",
                    cash: 1,
                    online: 1,
                    total: { $add: ["$cash", "$online"] }
                }
            }
        ]);

        return res.status(200).json(new apiResponse(200, responseMessage.getDataSuccess("collection"), collection, {}, {}));
    } catch (error) {
        console.log(error);
        return res.status(500).json(new apiResponse(500, responseMessage.internalServerError, {}, error, {}));
    }
};

export const getRemainingStock = async (req, res) => {
    reqInfo(req);
    let { dateFilter } = req.body, { user } = req.headers;
    try {
        const remaining = await stockModel.aggregate([
            { $sort: { date: -1 } },
            {
                $group: {
                    _id: "$itemId",
                    closingStock: { $first: "$closingStock" }
                }
            },
            {
                $lookup: {
                    from: "items",
                    localField: "_id",
                    foreignField: "_id",
                    as: "item"
                }
            },
            { $unwind: "$item" },
            {
                $project: {
                    itemName: "$item.name",
                    closingStock: 1
                }
            }
        ]);

        return res.status(200).json(new apiResponse(200, responseMessage.getDataSuccess("remaining stock"), remaining, {}, {}));
    } catch (error) {
        console.log(error);
        return res.status(500).json(new apiResponse(500, responseMessage.internalServerError, {}, error, {}));
    }
};