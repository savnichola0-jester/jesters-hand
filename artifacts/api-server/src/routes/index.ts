import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pushRouter from "./push";
import adminRouter from "./admin";
import shopifyRouter from "./shopify";
import agoraRouter from "./agora";
import chatRouter from "./chat";
import dealRouter from "./deal";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pushRouter);
router.use(adminRouter);
router.use(shopifyRouter);
router.use(agoraRouter);
router.use(chatRouter);
router.use(dealRouter);

export default router;
