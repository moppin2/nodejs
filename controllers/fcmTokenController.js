const { FcmToken } = require('../models');
const { Op } = require('sequelize');

exports.registerToken = async (req, res) => {
    console.log('registerTokens');
    try {
        const { fcm_token, platform, device_id } = req.body;
        const user_id = req.user.id;
        const user_type = req.user.userType;

        if (!fcm_token || !platform) {
            return res.status(400).json({ message: 'fcm_token과 platform은 필수입니다.' });
        }

        await FcmToken.upsert({
            user_id,
            user_type,
            fcm_token,
            platform,
            device_id
        });

        return res.json({ message: 'FCM 토큰이 등록되었습니다.' });
    } catch (err) {
        console.error('registerToken error:', err);
        return res.status(500).json({ message: 'FCM 토큰 등록 중 오류가 발생했습니다.' });
    }
};

exports.removeToken = async (req, res) => {
    console.log('removeToken');
    try {
        const { fcm_token } = req.body;

        if (!fcm_token) {
            return res.status(400).json({ message: 'fcm_token이 필요합니다.' });
        }

        await FcmToken.destroy({
            where: { fcm_token }
        });

        return res.json({ message: 'FCM 토큰이 삭제되었습니다.' });
    } catch (err) {
        console.error('removeToken error:', err);
        return res.status(500).json({ message: 'FCM 토큰 삭제 중 오류가 발생했습니다.' });
    }
};
