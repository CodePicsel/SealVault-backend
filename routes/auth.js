const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const User = require('../models/User');


const signToken = (userId)=>{
    const payload = {userId};
    const secret = process.env.JWT_SECRET;
    const expiresIn = process.env.JWT_EXPIRES || '1h';
    return jwt.sign(payload, secret, {expiresIn});
};

router.post(
    '/register',
    [
        check('email', 'Validate email required').isEmail(),
        check('password', 'Password must be 8+ chars').isLength({min:8})
    ],
    async (req, res) =>{
        const errors = validationResult(req);
        if(!errors.isEmpty()) return res.status(400).json({errors: errors.array()});
        try{
            const{email, password} = req.body;
            const existing = await User.findOne({ email });
            if (existing) return res.status(400).json({ message: 'Email already registered' });
            
            const user = new User({ email, password });
            await user.save();   
            
            const token = signToken(user._id);
            res.status(201).json({
                token,
                user: {id: user._id, email: user.email}
            });
        }catch (err){
            console.error(err);
            res.status(500).json({message: 'Server error'});
        }
    }
);

module.exports = router